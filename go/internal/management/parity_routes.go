package management

// This file owns the native counterparts for the route families introduced by
// the reviewed TypeScript lifecycle change. The handlers deliberately share
// the management API's config persistence and redaction helpers: a route that
// merely returns 404, or exports the in-memory config with credentials, is not
// parity.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

var changelogHeading = regexp.MustCompile(`^##\s+([^\s—-]+)\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$`)

func isUnauthenticatedPairingClaim(method, path string) bool {
	return method == http.MethodPost && path == "/api/host/pair/claim"
}

type nativeChangelogRelease struct {
	Version string   `json:"version"`
	Date    *string  `json:"date"`
	Entries []string `json:"entries"`
}

type nativeHostHistoryEntry struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	Reason    string    `json:"reason"`
	Hostname  string    `json:"hostname"`
	Port      int       `json:"port"`
}

func parseNativeChangelog(markdown string) []nativeChangelogRelease {
	var releases []nativeChangelogRelease
	current := -1
	for _, line := range strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n") {
		if match := changelogHeading.FindStringSubmatch(strings.TrimSpace(line)); match != nil {
			release := nativeChangelogRelease{Version: match[1], Entries: []string{}}
			if match[2] != "" {
				date := match[2]
				release.Date = &date
			}
			releases = append(releases, release)
			current = len(releases) - 1
			continue
		}
		if current < 0 {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > 2 && (strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ")) {
			releases[current].Entries = append(releases[current].Entries, strings.TrimSpace(trimmed[2:]))
		}
	}
	return releases
}

func (a *API) parityConfigPath(name string) string {
	if name == "" {
		return ""
	}
	if a.configPath != "" {
		return filepath.Join(filepath.Dir(a.configPath), name)
	}
	if a.storageHome != "" {
		return filepath.Join(a.storageHome, name)
	}
	return ""
}

func (a *API) persistParityConfig() error {
	if a.configPersistence == nil {
		return nil
	}
	return a.configPersistence.Update(func(_ *config.Config) {})
}

func (a *API) handleParityRoutes(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	switch {
	case path == "/api/changelog" && r.Method == http.MethodGet:
		return a.handleNativeChangelog(w)
	case path == "/api/export/capabilities" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"datasets": []map[string]any{{"id": "config", "label": "Sanitized configuration", "formats": []string{"json", "yaml", "toml", "xml", "csv", "tsv", "markdown", "html", "jsonl", "sql"}}},
			"archives": map[string]any{"zip": map[string]any{"available": false, "reason": "native archive adapter is not bundled"}, "sevenZip": map[string]any{"available": false, "encryptionAvailable": false, "encryptionUnavailableReason": "encrypted archive export is unavailable without a protected password channel"}},
		})
		return true
	case path == "/api/export" && r.Method == http.MethodPost:
		return a.handleNativeExport(w, r)
	case path == "/api/host" && (r.Method == http.MethodGet || r.Method == http.MethodPut):
		return a.handleNativeHost(w, r)
	case path == "/api/host/pair" && (r.Method == http.MethodPost || r.Method == http.MethodDelete):
		return a.handleNativePair(w, r)
	case path == "/api/host/pair/claim" && r.Method == http.MethodPost:
		return a.handleNativePairClaim(w, r)
	case path == "/api/host/export" && r.Method == http.MethodGet:
		payload, err := json.Marshal(safeConfig(a.config))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not serialize export")
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="opencodex-config.json"`)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(payload)
		return true
	case path == "/api/host/history" && r.Method == http.MethodGet:
		entries := a.readHostHistory()
		lines := make([]string, 0, len(entries))
		for _, entry := range entries {
			lines = append(lines, entry.ID+" "+entry.CreatedAt.UTC().Format(time.RFC3339)+" "+entry.Reason)
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "lines": lines, "available": true})
		return true
	case path == "/api/host/restore" && r.Method == http.MethodPost:
		return a.handleNativeHostRestore(w, r)
		return true
	case path == "/api/host/exit" && r.Method == http.MethodPost:
		writeJSON(w, http.StatusAccepted, map[string]any{"success": true, "status": "stopping"})
		if a.stop != nil {
			go a.stop()
		}
		return true
	case path == "/api/host/discover" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"hosts": []map[string]any{{"hostname": a.config.Host, "port": a.config.Port, "reachable": true, "source": "local"}}})
		return true
	case path == "/api/launch" && r.Method == http.MethodGet:
		return a.handleNativeLaunchList(w)
	case path == "/api/launch" && r.Method == http.MethodPost:
		return a.handleNativeLaunch(w, r)
	case path == "/api/launch/install" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "install_unavailable", "message": "native launch targets are reported but automatic installation is not available"})
		return true
	case path == "/api/terminal" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		return a.handleNativeTerminal(w, r)
	case strings.HasPrefix(path, "/api/terminal/"):
		writeError(w, http.StatusNotFound, "terminal session not found")
		return true
	}
	return false
}

func (a *API) handleNativeChangelog(w http.ResponseWriter) bool {
	path := a.changelogPath
	if path == "" {
		path = a.parityConfigPath("CHANGELOG.md")
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) || err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "releases": []nativeChangelogRelease{}})
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "releases": parseNativeChangelog(string(data))})
	return true
}

func (a *API) handleNativeExport(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		Dataset string `json:"dataset"`
		Format  string `json:"format"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.Dataset == "" {
		body.Dataset = "config"
	}
	if body.Dataset != "config" {
		writeError(w, http.StatusBadRequest, "unknown dataset")
		return true
	}
	format := strings.ToLower(strings.TrimSpace(body.Format))
	if format == "" {
		format = "json"
	}
	allowed := map[string]bool{"json": true, "jsonl": true, "yaml": true, "toml": true, "xml": true, "csv": true, "tsv": true, "markdown": true, "html": true, "sql": true}
	if !allowed[format] {
		writeError(w, http.StatusBadRequest, "unsupported export format")
		return true
	}
	jsonData, err := json.Marshal(safeConfig(a.config))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not serialize export")
		return true
	}
	data := jsonData
	contentType := "application/json"
	switch format {
	case "jsonl":
		data = append(jsonData, '\n')
		contentType = "application/x-ndjson"
	case "yaml":
		data = []byte("config: " + string(jsonData) + "\n")
		contentType = "application/yaml"
	case "toml":
		data = []byte("# Sanitized OpenCodex configuration\nconfig_json = " + strconv.Quote(string(jsonData)) + "\n")
		contentType = "application/toml"
	case "xml":
		data = []byte("<?xml version=\"1.0\"?><opencodex><config-json>" + xmlEscape(string(jsonData)) + "</config-json></opencodex>")
		contentType = "application/xml"
	case "csv":
		data = []byte("field,value\nconfig," + csvEscape(string(jsonData)) + "\n")
		contentType = "text/csv"
	case "tsv":
		data = []byte("field\tvalue\nconfig\t" + strings.ReplaceAll(string(jsonData), "\t", " ") + "\n")
		contentType = "text/tab-separated-values"
	case "markdown":
		data = []byte("# Sanitized configuration\n\n```json\n" + string(jsonData) + "\n```\n")
		contentType = "text/markdown"
	case "html":
		data = []byte("<!doctype html><meta charset=\"utf-8\"><pre>" + htmlEscape(string(jsonData)) + "</pre>")
		contentType = "text/html"
	case "sql":
		data = []byte("-- Sanitized configuration export\nINSERT INTO exports(format, payload) VALUES ('json', " + strconv.Quote(string(jsonData)) + ");\n")
		contentType = "application/sql"
	}
	w.Header().Set("Content-Type", contentType+"; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="opencodex-config.`+format+`"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
	return true
}

func (a *API) handleNativeHost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"hostname": a.config.Host, "port": a.config.Port, "exposed": !isLoopbackHost(a.config.Host), "credentialPresent": len(a.config.APIKeys) > 0, "restartRequired": false})
		return true
	}
	var body struct {
		Exposed  *bool  `json:"exposed"`
		Hostname string `json:"hostname"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.Exposed == nil {
		writeError(w, http.StatusBadRequest, "exposed must be true or false")
		return true
	}
	if *body.Exposed {
		host := strings.TrimSpace(body.Hostname)
		if host == "" {
			host = "0.0.0.0"
		}
		if isLoopbackHost(host) {
			writeError(w, http.StatusBadRequest, "hostname is a loopback address")
			return true
		}
		if len(a.config.APIKeys) == 0 {
			writeError(w, http.StatusConflict, "a data-plane credential is required before exposing the host")
			return true
		}
		a.recordHostHistory("before host exposure")
		a.config.Host = host
	} else {
		a.recordHostHistory("before host exposure disabled")
		a.config.Host = config.DefaultHost
	}
	if err := a.persistParityConfig(); err != nil {
		writeError(w, http.StatusInternalServerError, "could not persist host settings")
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"hostname": a.config.Host, "port": a.config.Port, "exposed": !isLoopbackHost(a.config.Host), "credentialPresent": len(a.config.APIKeys) > 0, "restartRequired": true})
	return true
}

func (a *API) hostHistoryPath() string { return a.parityConfigPath("host-history.json") }

func (a *API) readHostHistory() []nativeHostHistoryEntry {
	data, err := os.ReadFile(a.hostHistoryPath())
	if err != nil {
		return []nativeHostHistoryEntry{}
	}
	var entries []nativeHostHistoryEntry
	if json.Unmarshal(data, &entries) != nil {
		return []nativeHostHistoryEntry{}
	}
	return entries
}

func (a *API) recordHostHistory(reason string) {
	path := a.hostHistoryPath()
	if path == "" {
		return
	}
	entries := a.readHostHistory()
	entries = append(entries, nativeHostHistoryEntry{ID: fmt.Sprintf("host-%d", time.Now().UnixNano()), CreatedAt: time.Now().UTC(), Reason: reason, Hostname: a.config.Host, Port: a.config.Port})
	if len(entries) > 32 {
		entries = entries[len(entries)-32:]
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	data, err := json.MarshalIndent(entries, "", "  ")
	if err == nil {
		_ = os.WriteFile(path, append(data, '\n'), 0o600)
	}
}

func (a *API) handleNativeHostRestore(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		Commit string `json:"commit"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	commit := strings.TrimSpace(body.Commit)
	if commit == "" {
		writeError(w, http.StatusBadRequest, "commit is required")
		return true
	}
	var selected *nativeHostHistoryEntry
	for _, entry := range a.readHostHistory() {
		if entry.ID == commit {
			copy := entry
			selected = &copy
			break
		}
	}
	if selected == nil {
		writeError(w, http.StatusNotFound, "history entry not found")
		return true
	}
	a.config.Host = selected.Hostname
	a.config.Port = selected.Port
	if err := a.persistParityConfig(); err != nil {
		writeError(w, http.StatusInternalServerError, "could not persist restored host settings")
		return true
	}
	a.recordHostHistory("restored " + selected.ID)
	writeJSON(w, http.StatusAccepted, map[string]any{"success": true, "restored": selected.ID, "restartRequired": true})
	return true
}

func (a *API) handleNativePair(w http.ResponseWriter, r *http.Request) bool {
	a.pairMu.Lock()
	defer a.pairMu.Unlock()
	if r.Method == http.MethodDelete {
		a.pairToken = ""
		a.pairExpires = time.Time{}
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return true
	}
	if a.pairToken != "" && time.Now().Before(a.pairExpires) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "a pairing token is already active"})
		return true
	}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, 500, "could not create pairing token")
		return true
	}
	a.pairToken = base64.RawURLEncoding.EncodeToString(raw[:])
	a.pairExpires = time.Now().Add(5 * time.Minute)
	writeJSON(w, http.StatusOK, map[string]any{"token": a.pairToken, "expiresAt": a.pairExpires.UTC().Format(time.RFC3339)})
	return true
}

func (a *API) handleNativePairClaim(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, &body) || len(body.Token) < 20 || len(body.Token) > 128 {
		writeError(w, http.StatusBadRequest, "invalid pairing token")
		return true
	}
	a.pairMu.Lock()
	defer a.pairMu.Unlock()
	if body.Token != a.pairToken || a.pairToken == "" || !time.Now().Before(a.pairExpires) {
		writeError(w, http.StatusUnauthorized, "pairing token is invalid or expired")
		return true
	}
	a.pairToken = ""
	a.pairExpires = time.Time{}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, 500, "could not create data-plane key")
		return true
	}
	key := "ocx_" + base64.RawURLEncoding.EncodeToString(raw[:])
	a.config.APIKeys = append(a.config.APIKeys, config.ProxyAPIKey{ID: fmt.Sprintf("pair-%d", time.Now().UnixNano()), Name: "paired device", Key: key, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	if err := a.persistParityConfig(); err != nil {
		writeError(w, 500, "could not persist paired credential")
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "expiresAt": time.Now().UTC().Add(5 * time.Minute).Format(time.RFC3339)})
	return true
}

func (a *API) handleNativeLaunchList(w http.ResponseWriter) bool {
	writeJSON(w, http.StatusOK, map[string]any{"targets": []map[string]any{{"id": "codex", "kind": "cli", "label": "Codex", "available": false, "reason": "native executable discovery is not configured"}, {"id": "claude", "kind": "cli", "label": "Claude Code", "available": false, "reason": "native executable discovery is not configured"}, {"id": "grok", "kind": "cli", "label": "Grok", "available": false, "reason": "native executable discovery is not configured"}}})
	return true
}

func (a *API) handleNativeLaunch(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.ID != "codex" && body.ID != "claude" && body.ID != "grok" {
		writeError(w, http.StatusBadRequest, "unknown launch target")
		return true
	}
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "target_unavailable", "message": "launch target is not installed"})
	return true
}

func (a *API) handleNativeTerminal(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"presets": []map[string]any{{"id": "shell", "label": "Shell", "available": false}, {"id": "powershell", "label": "PowerShell", "available": false}}})
		return true
	}
	var body struct {
		Preset string `json:"preset"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.Preset != "shell" && body.Preset != "powershell" {
		writeError(w, http.StatusBadRequest, "unknown terminal preset")
		return true
	}
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "terminal_unavailable", "message": "terminal sessions are not available in the native management host"})
	return true
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" || host == "::"
}

func csvEscape(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }
func htmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(value)
}
func xmlEscape(value string) string { return htmlEscape(value) }
