package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

type ListenPIDScan struct {
	OK    bool
	PIDs  []int
	Error string
}

// ParseListenPIDsFromNetstat accepts both Windows `netstat -ano` and Unix
// `netstat -anlp` output. A wildcard foreign endpoint is treated as listening
// even when the localized state name is not English.
func ParseListenPIDsFromNetstat(output string, port int) []int {
	seen := make(map[int]struct{})
	suffix := ":" + strconv.Itoa(port)
	for _, raw := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || !strings.HasPrefix(strings.ToLower(line), "tcp") {
			continue
		}
		fields := strings.Fields(line)
		localIndex := -1
		for index, field := range fields {
			if strings.HasSuffix(field, suffix) || strings.HasSuffix(field, "]:"+strconv.Itoa(port)) {
				localIndex = index
				break
			}
		}
		if localIndex < 0 {
			continue
		}
		foreign := ""
		if localIndex+1 < len(fields) {
			foreign = fields[localIndex+1]
		}
		listening := strings.Contains(strings.ToUpper(line), "LISTEN") || foreign == "0.0.0.0:0" || foreign == "[::]:0" || foreign == ":::0" || foreign == "*:*"
		if !listening || len(fields) == 0 {
			continue
		}
		owner := fields[len(fields)-1]
		if slash := strings.IndexByte(owner, '/'); slash >= 0 {
			owner = owner[:slash]
		}
		pid, err := strconv.Atoi(owner)
		if err == nil && pid > 0 {
			seen[pid] = struct{}{}
		}
	}
	result := make([]int, 0, len(seen))
	for pid := range seen {
		result = append(result, pid)
	}
	sort.Ints(result)
	return result
}

// ScanListenPIDs distinguishes a failed ownership probe from a successful
// empty scan; reclaim must never interpret a missing diagnostic tool as proof
// that killing or TCP-row deletion is safe.
func ScanListenPIDs(ctx context.Context, port int) ListenPIDScan {
	if port <= 0 || port > 65535 {
		return ListenPIDScan{Error: "invalid port"}
	}
	probeContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if runtime.GOOS == "windows" {
		output, err := exec.CommandContext(probeContext, "netstat", "-ano", "-p", "tcp").CombinedOutput()
		if err != nil {
			return ListenPIDScan{Error: err.Error()}
		}
		return ListenPIDScan{OK: true, PIDs: ParseListenPIDsFromNetstat(string(output), port)}
	}
	output, err := exec.CommandContext(probeContext, "lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN", "-t").CombinedOutput()
	if err == nil {
		return ListenPIDScan{OK: true, PIDs: parsePIDLines(string(output))}
	}
	output, netstatErr := exec.CommandContext(probeContext, "netstat", "-anlp").CombinedOutput()
	if netstatErr != nil {
		return ListenPIDScan{Error: fmt.Sprintf("lsof/netstat unavailable: %v / %v", err, netstatErr)}
	}
	return ListenPIDScan{OK: true, PIDs: ParseListenPIDsFromNetstat(string(output), port)}
}

func parsePIDLines(output string) []int {
	seen := make(map[int]struct{})
	for _, line := range strings.Fields(output) {
		if pid, err := strconv.Atoi(line); err == nil && pid > 0 {
			seen[pid] = struct{}{}
		}
	}
	result := make([]int, 0, len(seen))
	for pid := range seen {
		result = append(result, pid)
	}
	sort.Ints(result)
	return result
}

type ReclaimListenPortOptions struct {
	Timeout, Interval, ScanInterval time.Duration
	KillHolders                     bool
	OnlyKillPIDs                    []int
	DropTCPRows                     bool
	DisableTCPDrop                  bool
	Scan                            func(context.Context, int) ListenPIDScan
	IsAlive                         func(int) bool
	VerifyOpenCodex                 func(int) bool
	Kill                            func(context.Context, int) error
	DropTCP                         func(int) error
	IsAvailable                     func(string, int) bool
	Sleep                           func(context.Context, time.Duration) error
}

// ReclaimListenPort waits for a stable configured address. Process termination
// requires all three safeguards: an explicit opt-in, a non-empty PID allowlist,
// and a fresh OpenCodex identity check immediately before the kill.
func ReclaimListenPort(ctx context.Context, host string, port int, options ReclaimListenPortOptions) bool {
	if options.Timeout <= 0 {
		options.Timeout = 30 * time.Second
	}
	if options.Interval <= 0 {
		options.Interval = 100 * time.Millisecond
	}
	if options.ScanInterval <= 0 {
		options.ScanInterval = 500 * time.Millisecond
	}
	if options.Scan == nil {
		options.Scan = ScanListenPIDs
	}
	if options.IsAlive == nil {
		options.IsAlive = platform.ProcessAlive
	}
	if options.Kill == nil {
		options.Kill = platform.KillProcess
	}
	if options.IsAvailable == nil {
		options.IsAvailable = IsPortAvailable
	}
	if options.DropTCP == nil && runtime.GOOS == "windows" {
		options.DropTCP = func(port int) error {
			_, err := DropWindowsTCPRowsForLocalPort(port)
			return err
		}
	}
	if options.Sleep == nil {
		options.Sleep = func(ctx context.Context, delay time.Duration) error {
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
	allowed := make(map[int]struct{}, len(options.OnlyKillPIDs))
	for _, pid := range options.OnlyKillPIDs {
		if pid > 0 {
			allowed[pid] = struct{}{}
		}
	}
	mayKill := options.KillHolders && len(allowed) > 0 && options.VerifyOpenCodex != nil
	dropTCPRows := options.DropTCPRows || (runtime.GOOS == "windows" && !options.DisableTCPDrop)
	deadline := time.Now().Add(options.Timeout)
	lastScan := time.Time{}
	killed := make(map[int]struct{})
	for {
		if options.IsAvailable(host, port) {
			return true
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			return false
		}
		if lastScan.IsZero() || time.Since(lastScan) >= options.ScanInterval {
			lastScan = time.Now()
			scan := options.Scan(ctx, port)
			if !scan.OK {
				if options.Sleep(ctx, options.Interval) != nil {
					return false
				}
				continue
			}
			foreignOrProtected := false
			for _, pid := range scan.PIDs {
				if pid == os.Getpid() || !options.IsAlive(pid) {
					continue
				}
				_, allowlisted := allowed[pid]
				if !mayKill || !allowlisted || !options.VerifyOpenCodex(pid) {
					foreignOrProtected = true
					continue
				}
				if _, alreadyKilled := killed[pid]; !alreadyKilled {
					if !options.IsAlive(pid) || !options.VerifyOpenCodex(pid) {
						foreignOrProtected = true
						continue
					}
					if err := options.Kill(ctx, pid); err != nil {
						foreignOrProtected = true
						continue
					}
					killed[pid] = struct{}{}
				}
				if options.IsAlive(pid) {
					foreignOrProtected = true
				}
			}
			if !foreignOrProtected && dropTCPRows && options.DropTCP != nil {
				_ = options.DropTCP(port)
			}
		}
		if options.Sleep(ctx, options.Interval) != nil {
			return false
		}
	}
}
