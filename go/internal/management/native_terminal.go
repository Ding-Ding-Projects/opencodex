package management

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const maxTerminalInput = 8 << 10
const maxTerminalChunks = 1500

type nativeTerminalChunk struct {
	Seq    int    `json:"seq"`
	Text   string `json:"text"`
	Stream string `json:"stream"`
}
type nativeTerminalView struct {
	ID         string     `json:"id"`
	PresetID   string     `json:"presetId"`
	Label      string     `json:"label"`
	State      string     `json:"state"`
	ExitCode   *int       `json:"exitCode,omitempty"`
	StartedAt  time.Time  `json:"startedAt"`
	EndedAt    *time.Time `json:"endedAt,omitempty"`
	FullScreen bool       `json:"fullScreen"`
}
type nativeTerminalSession struct {
	mu     sync.Mutex
	view   nativeTerminalView
	child  *exec.Cmd
	stdin  io.WriteCloser
	chunks []nativeTerminalChunk
	seq    int
}

func terminalPresets() []map[string]any {
	return []map[string]any{{"id": "shell", "label": "Shell", "target": nil, "args": []string{}, "fullScreen": false}, {"id": "codex", "label": "Codex CLI", "target": "codex-cli", "args": []string{}, "fullScreen": true}, {"id": "claude", "label": "Claude Code", "target": "claude-cli", "args": []string{}, "fullScreen": true}, {"id": "grok", "label": "Grok CLI", "target": "grok-cli", "args": []string{}, "fullScreen": true}}
}

func terminalCommand(preset string) (string, []string, bool) {
	switch preset {
	case "shell":
		if runtime.GOOS == "windows" {
			return "powershell.exe", []string{"-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"}, true
		}
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/bash"
		}
		return shell, []string{"-i"}, true
	case "codex", "claude", "grok":
		id := map[string]string{"codex": "codex-cli", "claude": "claude-cli", "grok": "grok-cli"}[preset]
		for _, name := range []string{id + ".exe", id + ".cmd", id, id + ".bat"} {
			if path, err := exec.LookPath(name); err == nil {
				return path, []string{}, true
			}
		}
		return "", nil, false
	default:
		return "", nil, false
	}
}

func (a *API) terminalAllowed() bool { return a.loopback != nil && a.loopback() }
func (a *API) terminalRecord(session *nativeTerminalSession, text, stream string) {
	if text == "" {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.seq++
	session.chunks = append(session.chunks, nativeTerminalChunk{Seq: session.seq, Text: text, Stream: stream})
	if len(session.chunks) > maxTerminalChunks {
		session.chunks = session.chunks[len(session.chunks)-maxTerminalChunks:]
	}
}

func (a *API) createTerminalSession(preset string) (nativeTerminalView, error) {
	command, args, ok := terminalCommand(preset)
	if !ok {
		return nativeTerminalView{}, fmt.Errorf("unknown terminal preset or unavailable CLI target")
	}
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	running := 0
	for _, s := range a.terminalSessions {
		s.mu.Lock()
		if s.view.State == "running" {
			running++
		}
		s.mu.Unlock()
	}
	if running >= 12 {
		return nativeTerminalView{}, fmt.Errorf("too many terminal sessions open")
	}
	cmd := exec.Command(command, args...)
	cmd.Dir, _ = os.UserHomeDir()
	cmd.Env = append(os.Environ(), "TERM=dumb", "NO_COLOR=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nativeTerminalView{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nativeTerminalView{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nativeTerminalView{}, err
	}
	if err := cmd.Start(); err != nil {
		return nativeTerminalView{}, err
	}
	now := time.Now().UTC()
	id := fmt.Sprintf("term-%d", now.UnixNano())
	label := preset
	if preset == "shell" {
		label = "Shell"
	}
	session := &nativeTerminalSession{view: nativeTerminalView{ID: id, PresetID: preset, Label: label, State: "running", StartedAt: now, FullScreen: preset != "shell"}, child: cmd, stdin: stdin}
	a.terminalSessions[id] = session
	go a.readTerminalPipe(session, stdout, "out")
	go a.readTerminalPipe(session, stderr, "err")
	go func() {
		err := cmd.Wait()
		session.mu.Lock()
		if session.view.State == "exited" {
			session.mu.Unlock()
			return
		}
		session.view.State = "exited"
		ended := time.Now().UTC()
		session.view.EndedAt = &ended
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code := exit.ExitCode()
				session.view.ExitCode = &code
			}
		}
		session.mu.Unlock()
	}()
	return session.view, nil
}

func (a *API) readTerminalPipe(session *nativeTerminalSession, reader io.Reader, stream string) {
	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			a.terminalRecord(session, string(buffer[:n]), stream)
		}
		if err != nil {
			return
		}
	}
}
func (a *API) terminalView(session *nativeTerminalSession) nativeTerminalView {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.view
}

func (a *API) handleNativeTerminalReal(w http.ResponseWriter, r *http.Request) bool {
	if !a.terminalAllowed() {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "embedded terminal requires a proven loopback listener"})
		return true
	}
	if r.URL.Path == "/api/terminal" && r.Method == http.MethodGet {
		sessions := []nativeTerminalView{}
		a.terminalMu.Lock()
		for _, s := range a.terminalSessions {
			sessions = append(sessions, a.terminalView(s))
		}
		a.terminalMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"presets": terminalPresets(), "sessions": sessions})
		return true
	}
	if r.URL.Path == "/api/terminal" && r.Method == http.MethodPost {
		var body struct {
			Preset string `json:"preset"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		view, err := a.createTerminalSession(strings.TrimSpace(body.Preset))
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": view})
		return true
	}
	if strings.HasPrefix(r.URL.Path, "/api/terminal/") {
		return a.handleNativeTerminalSession(w, r)
	}
	return false
}

func (a *API) handleNativeTerminalSession(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/terminal/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, 404, "unknown terminal session")
		return true
	}
	id := parts[0]
	a.terminalMu.Lock()
	session := a.terminalSessions[id]
	a.terminalMu.Unlock()
	if session == nil {
		writeError(w, 404, "unknown terminal session")
		return true
	}
	if len(parts) == 2 && parts[1] == "input" && r.Method == http.MethodPost {
		var body struct {
			Data string `json:"data"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if len([]byte(body.Data)) > maxTerminalInput {
			writeError(w, 413, "terminal input too large")
			return true
		}
		session.mu.Lock()
		if session.view.State != "running" {
			session.mu.Unlock()
			writeError(w, 409, "session has exited")
			return true
		}
		_, err := io.Copy(session.stdin, bytes.NewBufferString(body.Data))
		session.mu.Unlock()
		if err != nil {
			writeError(w, 409, "terminal input failed")
			return true
		}
		a.terminalRecord(session, body.Data, "in")
		writeJSON(w, 200, map[string]any{"ok": true})
		return true
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		since := 0
		if raw := r.URL.Query().Get("since"); raw != "" {
			fmt.Sscanf(raw, "%d", &since)
		}
		session.mu.Lock()
		chunks := []nativeTerminalChunk{}
		for _, chunk := range session.chunks {
			if chunk.Seq > since {
				chunks = append(chunks, chunk)
			}
		}
		cursor := session.seq
		view := session.view
		session.mu.Unlock()
		writeJSON(w, 200, map[string]any{"session": view, "chunks": chunks, "cursor": cursor})
		return true
	}
	if len(parts) == 1 && r.Method == http.MethodDelete {
		session.mu.Lock()
		if session.child.Process != nil && session.view.State == "running" {
			terminateNativeTerminal(session.child)
		}
		session.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true})
		return true
	}
	writeError(w, 404, "unknown terminal session")
	return true
}

func terminateNativeTerminal(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run()
		return
	}
	_ = cmd.Process.Kill()
}

func (a *API) killAllTerminalSessions() {
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	for _, session := range a.terminalSessions {
		session.mu.Lock()
		if session.view.State == "running" {
			terminateNativeTerminal(session.child)
		}
		session.mu.Unlock()
	}
}
