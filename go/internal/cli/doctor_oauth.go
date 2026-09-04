package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func appendOAuthDoctorChecks(ctx context.Context, report *doctorReport, ocxHome string, port int, cfg *config.Config, token string, deps doctorDeps) {
	authPath := filepath.Join(ocxHome, "auth.json")
	if oauthStorageWritable(authPath, deps) {
		report.add(doctorCheck{Name: "OAuth credential storage", Status: doctorPass, Detail: "directory is writable for atomic auth.json updates"})
	} else {
		report.add(doctorCheck{Name: "OAuth credential storage", Status: doctorWarn, Detail: "directory is not writable", Hint: "Action: fix permissions on OPENCODEX_HOME so ocx can create temp files and rename auth.json"})
	}
	store := oauth.NewCredentialStore(authPath)
	if strings.Contains(filepath.Base(store.RefreshIntentPath("doctor-probe", "probe-account")), "auth.refresh.") && oauthStorageWritable(authPath, deps) {
		report.add(doctorCheck{Name: "OAuth refresh single-flight", Status: doctorPass, Detail: "Token refresh single-flight is active"})
	} else {
		report.add(doctorCheck{Name: "OAuth refresh single-flight", Status: doctorWarn, Detail: "refresh lock files are unavailable", Hint: "Action: fix permissions on OPENCODEX_HOME so ocx can create refresh lock files"})
	}
	baseURL := ""
	if port > 0 {
		baseURL = serviceBaseURLAt(*cfg, port)
	}
	health := collectOAuthCLIHealth(ctx, oauthHealthCollectOptions{AuthPath: authPath, BaseURL: baseURL, Token: token, HTTPClient: deps.HTTPClient, ReadFile: deps.ReadFile, Now: deps.Now()})
	if health.CodexHealthSource == "unavailable" {
		report.add(doctorCheck{Name: "Codex account health", Status: doctorWarn, Detail: "unavailable (proxy not running)", Hint: "Action: start the proxy and re-run 'ocx doctor' to inspect live cooldown/reauth"})
	}
	for _, entry := range health.Entries {
		if entry.Health.Status == "healthy" {
			continue
		}
		masked := ocxlib.MaskAccountID(entry.AccountID)
		if masked == "" {
			masked = maskedAccountFallback
		}
		action := entry.Action
		if entry.Provider == "codex" {
			action = "reauthenticate via the dashboard Codex account pool"
		} else if entry.Health.Status == "warning" && entry.Health.Reason == "stale_credentials" {
			action = fmt.Sprintf("run `ocx login %s`", entry.Provider)
		} else if entry.Health.Status == "warning" && entry.Health.Reason == "metadata_mismatch" {
			action = fmt.Sprintf("run `ocx login %s` to refresh credentials", entry.Provider)
		}
		if action == "" {
			action = fmt.Sprintf("run `ocx doctor` again after fixing OAuth state for %s", entry.Provider)
		}
		report.add(doctorCheck{Name: "OAuth account " + entry.Provider, Status: doctorWarn, Detail: masked + " " + describeOAuthHealth(entry), Hint: "Action: " + action})
	}
	report.add(doctorCheck{Name: "Codex client metadata", Status: doctorPass, Detail: "forward path uses pass-through client metadata (build-time invariant; not a runtime scan)"})
}

func oauthStorageWritable(authPath string, deps doctorDeps) bool {
	path := filepath.Dir(authPath)
	for range 8 {
		info, err := deps.Stat(path)
		if err == nil {
			if !info.IsDir() {
				return false
			}
			if deps.GOOS == "windows" || runtime.GOOS == "windows" {
				return true
			}
			permissions := info.Mode().Perm()
			return permissions&0o222 != 0 && permissions&0o111 != 0
		}
		if !os.IsNotExist(err) {
			return false
		}
		next := filepath.Dir(path)
		if next == path {
			break
		}
		path = next
	}
	return false
}
