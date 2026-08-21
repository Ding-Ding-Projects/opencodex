package management

// This file owns the native counterparts for the route families introduced by
// the reviewed TypeScript lifecycle change. The handlers deliberately share
// the management API's config persistence and redaction helpers: a route that
// merely returns 404, or exports the in-memory config with credentials, is not
// parity.

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

var changelogHeading = regexp.MustCompile(`^##\s+([^\s—-]+)\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$`)

const (
	maxPairClaimBody   = 4 << 10
	maxPairAttempts    = 10
	pairAttemptWindow  = time.Minute
	defaultDrainWindow = time.Minute
	maxDrainWindow     = 5 * time.Minute
)

func isUnauthenticatedPairingClaim(method, path string) bool {
	return method == http.MethodPost && path == "/api/host/pair/claim"
}

func writeNoStoreJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, value)
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

type nativeHostHistoryStored struct {
	nativeHostHistoryEntry
	Config json.RawMessage `json:"config"`
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
			"archives": map[string]any{"zip": map[string]any{"available": true}, "sevenZip": map[string]any{"available": false, "encryptionAvailable": false, "encryptionUnavailableReason": "encrypted archive export is unavailable without a protected password channel"}},
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
		bundle := map[string]any{"kind": "opencodex-export", "exportedAt": time.Now().UTC().Format(time.RFC3339Nano), "warning": "Native export is sanitized and omits provider keys, OAuth tokens, and other secret-bearing state.", "config": safeConfig(a.config), "divergence": "Full TypeScript state-bundle export is not yet available on the native line."}
		payload, err := json.Marshal(bundle)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not serialize export")
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="opencodex-export.json"`)
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
	case path == "/api/host/exit" && r.Method == http.MethodPost:
		var body struct {
			DrainMS int  `json:"drainMs"`
			Force   bool `json:"force"`
		}
		if r.ContentLength != 0 && !decodeJSON(w, r, &body) {
			return true
		}
		drain := defaultDrainWindow
		if body.DrainMS > 0 {
			drain = time.Duration(body.DrainMS) * time.Millisecond
			if drain > maxDrainWindow {
				drain = maxDrainWindow
			}
		}
		if a.drain != nil {
			drained, remaining := a.drain(drain)
			if !drained && !body.Force {
				writeJSON(w, http.StatusConflict, map[string]any{"success": false, "reason": "sessions-in-progress", "activeTurnCount": remaining})
				return true
			}
		}
		writeNoStoreJSON(w, http.StatusAccepted, map[string]any{"success": true, "status": "stopping", "drained": true})
		if a.stop != nil {
			go a.stop()
		}
		return true
	case path == "/api/host/discover" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		host := strings.Trim(strings.TrimSpace(a.config.Host), "[]")
		if host == "" || host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		reachable := false
		if a.config.Port > 0 {
			connection, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(a.config.Port)), 250*time.Millisecond)
			if err == nil {
				reachable = true
				_ = connection.Close()
			}
		}
		found := []map[string]any{}
		if reachable {
			found = append(found, map[string]any{"hostname": host, "port": a.config.Port, "reachable": true, "source": "local-probe"})
		}
		writeJSON(w, http.StatusOK, map[string]any{"found": found, "hosts": found})
		return true
	case path == "/api/launch" && r.Method == http.MethodGet:
		return a.handleNativeLaunchList(w)
	case path == "/api/launch" && r.Method == http.MethodPost:
		return a.handleNativeLaunch(w, r)
	case (path == "/api/launch/install" || strings.HasPrefix(path, "/api/launch/install/")) && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "install_unavailable", "message": "native launch targets are reported but automatic installation is not available"})
		return true
	case path == "/api/terminal" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		return a.handleNativeTerminalReal(w, r)
	case strings.HasPrefix(path, "/api/terminal/"):
		return a.handleNativeTerminalReal(w, r)
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
		Archive string `json:"archive"`
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
	if body.Archive != "" {
		if body.Archive != "zip" {
			writeError(w, http.StatusConflict, "7z archive export is unavailable on the native line")
			return true
		}
		var archive bytes.Buffer
		writer := zip.NewWriter(&archive)
		file, err := writer.Create("opencodex-config." + format)
		if err != nil {
			writeError(w, 500, "could not create export archive")
			return true
		}
		if _, err = file.Write(data); err != nil {
			writeError(w, 500, "could not write export archive")
			return true
		}
		if err = writer.Close(); err != nil {
			writeError(w, 500, "could not finalize export archive")
			return true
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="opencodex-config.zip"`)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(archive.Bytes())
		return true
	}
	w.Header().Set("Content-Type", contentType+"; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="opencodex-config.`+format+`"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
	return true
}

func (a *API) handleNativeHost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, a.nativeHostStatus(false, nil))
		return true
	}
	var body struct {
		Exposed          *bool  `json:"exposed"`
		Hostname         string `json:"hostname"`
		NewKeyName       string `json:"newKeyName"`
		CustomKeyValue   string `json:"customKeyValue"`
		MintKeyIfMissing bool   `json:"mintKeyIfMissing"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if body.Exposed == nil && body.CustomKeyValue != "" {
		before, err := cloneParityConfig(a.config)
		if err != nil {
			writeError(w, 500, "could not prepare host settings")
			return true
		}
		key, errText := addNativeCustomKey(a.config, body.NewKeyName, body.CustomKeyValue)
		if errText != "" {
			writeError(w, http.StatusBadRequest, errText)
			return true
		}
		if err := a.persistParityConfig(); err != nil {
			*a.config = *before
			writeNoStoreJSON(w, 500, map[string]any{"error": "host key could not be saved"})
			return true
		}
		writeNoStoreJSON(w, http.StatusOK, a.nativeHostStatus(false, &key))
		return true
	}
	if body.Exposed == nil {
		writeError(w, http.StatusBadRequest, "exposed must be true or false")
		return true
	}
	before, err := cloneParityConfig(a.config)
	if err != nil {
		writeError(w, 500, "could not prepare host settings")
		return true
	}
	var mintedKey *string
	if *body.Exposed {
		host := strings.TrimSpace(body.Hostname)
		if host == "" {
			host = "0.0.0.0"
		}
		if isLoopbackHost(host) {
			writeError(w, http.StatusBadRequest, "hostname is a loopback address")
			return true
		}
		if body.CustomKeyValue != "" {
			key, errText := addNativeCustomKey(a.config, body.NewKeyName, body.CustomKeyValue)
			if errText != "" {
				writeError(w, http.StatusBadRequest, errText)
				return true
			}
			mintedKey = &key
		} else if body.MintKeyIfMissing && len(a.config.APIKeys) == 0 {
			key, err := mintNativeDataPlaneKey(a.config, body.NewKeyName)
			if err != nil {
				writeError(w, 500, err.Error())
				return true
			}
			mintedKey = &key
		} else if body.NewKeyName != "" {
			key, err := mintNativeDataPlaneKey(a.config, body.NewKeyName)
			if err != nil {
				writeError(w, 500, err.Error())
				return true
			}
			mintedKey = &key
		}
		if len(a.config.APIKeys) == 0 {
			writeError(w, http.StatusConflict, "a data-plane credential is required before exposing the host")
			return true
		}
		a.config.Host = host
	} else {
		a.config.Host = config.DefaultHost
	}
	if err := a.persistParityConfig(); err != nil {
		*a.config = *before
		writeNoStoreJSON(w, http.StatusInternalServerError, map[string]any{"error": "host settings could not be saved"})
		return true
	}
	a.recordHostHistory("host settings changed")
	writeNoStoreJSON(w, http.StatusOK, a.nativeHostStatus(true, mintedKey))
	return true
}

func (a *API) nativeHostStatus(restartRequired bool, mintedKey *string) map[string]any {
	host := a.config.Host
	if strings.TrimSpace(host) == "" {
		host = config.DefaultHost
	}
	result := map[string]any{"hostname": host, "port": a.config.Port, "exposed": !isLoopbackHost(host), "credentialConfigured": len(a.config.APIKeys) > 0, "urls": []string{}, "debugSandbox": false, "restartRequired": restartRequired}
	if mintedKey != nil {
		result["mintedKey"] = *mintedKey
	}
	return result
}

func (a *API) hostHistoryPath() string { return a.parityConfigPath("host-history.json") }

func (a *API) readHostHistory() []nativeHostHistoryEntry {
	stored := a.readHostHistoryStored()
	entries := make([]nativeHostHistoryEntry, 0, len(stored))
	for _, entry := range stored {
		entries = append(entries, entry.nativeHostHistoryEntry)
	}
	return entries
}

func (a *API) readHostHistoryStored() []nativeHostHistoryStored {
	data, err := os.ReadFile(a.hostHistoryPath())
	if err != nil {
		return []nativeHostHistoryStored{}
	}
	var entries []nativeHostHistoryStored
	if json.Unmarshal(data, &entries) != nil {
		return []nativeHostHistoryStored{}
	}
	return entries
}

func (a *API) recordHostHistory(reason string) {
	path := a.hostHistoryPath()
	if path == "" {
		return
	}
	entries := a.readHostHistoryStored()
	snapshot, err := json.Marshal(a.config)
	if err != nil {
		return
	}
	entries = append(entries, nativeHostHistoryStored{nativeHostHistoryEntry: nativeHostHistoryEntry{ID: fmt.Sprintf("host-%d", time.Now().UnixNano()), CreatedAt: time.Now().UTC(), Reason: reason, Hostname: a.config.Host, Port: a.config.Port}, Config: snapshot})
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
		Commit  string `json:"commit"`
		DrainMS int    `json:"drainMs"`
		Force   bool   `json:"force"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	commit := strings.TrimSpace(body.Commit)
	if commit == "" {
		writeError(w, http.StatusBadRequest, "commit is required")
		return true
	}
	var selected *nativeHostHistoryStored
	for _, entry := range a.readHostHistoryStored() {
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
	drain := defaultDrainWindow
	if body.DrainMS > 0 {
		drain = time.Duration(body.DrainMS) * time.Millisecond
		if drain > maxDrainWindow {
			drain = maxDrainWindow
		}
	}
	if a.drain != nil {
		drained, remaining := a.drain(drain)
		if !drained && !body.Force {
			writeJSON(w, http.StatusConflict, map[string]any{"success": false, "reason": "sessions-in-progress", "activeTurnCount": remaining})
			return true
		}
	}
	var restored config.Config
	if len(selected.Config) == 0 || json.Unmarshal(selected.Config, &restored) != nil {
		writeError(w, http.StatusConflict, "history entry has no restorable configuration")
		return true
	}
	before, err := cloneParityConfig(a.config)
	if err != nil {
		writeError(w, 500, "could not prepare restore")
		return true
	}
	*a.config = restored
	if err := a.persistParityConfig(); err != nil {
		*a.config = *before
		writeError(w, http.StatusInternalServerError, "could not persist restored host settings")
		return true
	}
	a.recordHostHistory("restored " + selected.ID)
	restarting := a.restart != nil && a.restart.Restart != nil
	if restarting {
		a.scheduleParityRestart()
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "restored": selected.ID, "restartRequired": restarting})
	return true
}

func (a *API) scheduleParityRestart() {
	if a.restart == nil || a.restart.Restart == nil {
		return
	}
	schedule := a.restart.Schedule
	if schedule == nil {
		schedule = func(fn func(), delay time.Duration) { time.AfterFunc(delay, fn) }
	}
	schedule(func() {
		if a.restart.Drain != nil {
			a.restart.Drain(defaultDrainWindow)
		}
		a.restart.Restart()
	}, 200*time.Millisecond)
}

func (a *API) handleNativePair(w http.ResponseWriter, r *http.Request) bool {
	a.pairMu.Lock()
	defer a.pairMu.Unlock()
	if r.Method == http.MethodDelete {
		a.pairToken = ""
		a.pairExpires = time.Time{}
		a.pairArmedWindow = time.Time{}
		a.pairArmedAttempts = 0
		writeNoStoreJSON(w, http.StatusOK, map[string]any{"ok": true})
		return true
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeNoStoreJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not create pairing token"})
		return true
	}
	a.pairToken = base64.RawURLEncoding.EncodeToString(raw[:])
	a.pairExpires = time.Now().Add(5 * time.Minute)
	a.pairArmedWindow = time.Now()
	a.pairArmedAttempts = 0
	writeNoStoreJSON(w, http.StatusOK, map[string]any{"token": a.pairToken, "expiresAt": a.pairExpires.UnixMilli()})
	return true
}

func (a *API) handleNativePairClaim(w http.ResponseWriter, r *http.Request) bool {
	a.pairMu.Lock()
	defer a.pairMu.Unlock()
	now := time.Now()
	armed := a.pairToken != "" && now.Before(a.pairExpires)
	window, attempts := a.pairIdleWindow, a.pairIdleAttempts
	if armed {
		window, attempts = a.pairArmedWindow, a.pairArmedAttempts
	}
	if window.IsZero() || now.Sub(window) >= pairAttemptWindow {
		window, attempts = now, 0
	}
	attempts++
	if armed {
		a.pairArmedWindow, a.pairArmedAttempts = window, attempts
	} else {
		a.pairIdleWindow, a.pairIdleAttempts = window, attempts
	}
	if attempts > maxPairAttempts {
		w.Header().Set("Retry-After", "60")
		writeNoStoreJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too many pairing attempts"})
		return true
	}
	limited := http.MaxBytesReader(w, r.Body, maxPairClaimBody)
	rawBody, err := io.ReadAll(limited)
	if err != nil || len(rawBody) > maxPairClaimBody {
		writeNoStoreJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "pairing request was too large"})
		return true
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rawBody, &body); err != nil {
		writeNoStoreJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON"})
		return true
	}
	if len(body.Token) != 43 || a.pairToken == "" || !now.Before(a.pairExpires) {
		writeNoStoreJSON(w, http.StatusBadRequest, map[string]any{"error": "pairing token was not accepted", "reason": "expired"})
		return true
	}
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(a.pairToken)) != 1 {
		writeNoStoreJSON(w, http.StatusBadRequest, map[string]any{"error": "pairing token was not accepted", "reason": "mismatch"})
		return true
	}
	previous, cloneErr := cloneParityConfig(a.config)
	if cloneErr != nil {
		writeNoStoreJSON(w, http.StatusInternalServerError, map[string]any{"error": "the pairing key could not be saved"})
		return true
	}
	oldToken, oldExpiry := a.pairToken, a.pairExpires
	oldArmedWindow, oldArmedAttempts, oldIdleWindow, oldIdleAttempts := a.pairArmedWindow, a.pairArmedAttempts, a.pairIdleWindow, a.pairIdleAttempts
	a.pairToken = ""
	a.pairExpires = time.Time{}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		a.pairToken, a.pairExpires = oldToken, oldExpiry
		a.pairArmedWindow, a.pairArmedAttempts, a.pairIdleWindow, a.pairIdleAttempts = oldArmedWindow, oldArmedAttempts, oldIdleWindow, oldIdleAttempts
		writeNoStoreJSON(w, http.StatusInternalServerError, map[string]any{"error": "the pairing key could not be saved"})
		return true
	}
	key := "ocx_" + base64.RawURLEncoding.EncodeToString(raw[:])
	a.config.APIKeys = append(a.config.APIKeys, config.ProxyAPIKey{ID: fmt.Sprintf("pair-%d", time.Now().UnixNano()), Name: "Paired device", Key: key, CreatedAt: now.UTC().Format(time.RFC3339)})
	if err := a.persistParityConfig(); err != nil {
		*a.config = *previous
		a.pairToken, a.pairExpires = oldToken, oldExpiry
		a.pairArmedWindow, a.pairArmedAttempts, a.pairIdleWindow, a.pairIdleAttempts = oldArmedWindow, oldArmedAttempts, oldIdleWindow, oldIdleAttempts
		writeNoStoreJSON(w, http.StatusInternalServerError, map[string]any{"error": "the pairing key could not be saved"})
		return true
	}
	writeNoStoreJSON(w, http.StatusOK, map[string]any{"key": key})
	return true
}

func cloneParityConfig(source *config.Config) (*config.Config, error) {
	data, err := json.Marshal(source)
	if err != nil {
		return nil, err
	}
	var clone config.Config
	if err := json.Unmarshal(data, &clone); err != nil {
		return nil, err
	}
	return &clone, nil
}

func mintNativeDataPlaneKey(cfg *config.Config, name string) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("could not create data-plane key")
	}
	key := "ocx_" + base64.RawURLEncoding.EncodeToString(raw[:])
	if strings.TrimSpace(name) == "" {
		name = "network"
	}
	cfg.APIKeys = append(cfg.APIKeys, config.ProxyAPIKey{ID: fmt.Sprintf("key-%d", time.Now().UnixNano()), Name: name, Key: key, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	return key, nil
}

func addNativeCustomKey(cfg *config.Config, name, value string) (string, string) {
	key := strings.TrimSpace(value)
	if len(key) < 12 {
		return "", "custom key must be at least 12 characters"
	}
	if strings.IndexFunc(key, func(r rune) bool { return r == '\r' || r == '\n' || r == ' ' || r == '\t' }) >= 0 {
		return "", "custom key must not contain whitespace"
	}
	for _, existing := range cfg.APIKeys {
		if existing.Key == key {
			return "", "a key with this exact value already exists"
		}
	}
	if strings.TrimSpace(name) == "" {
		name = "custom"
	}
	cfg.APIKeys = append(cfg.APIKeys, config.ProxyAPIKey{ID: fmt.Sprintf("key-%d", time.Now().UnixNano()), Name: name, Key: key, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	return key, ""
}

func (a *API) handleNativeLaunchList(w http.ResponseWriter) bool {
	targets := []map[string]any{}
	for _, target := range nativeLaunchTargets() {
		path, ok := resolveNativeLaunchTarget(target)
		row := map[string]any{"id": target.ID, "label": target.Label, "kind": target.Kind, "available": ok, "installUrl": target.InstallURL}
		if !ok {
			row["reason"] = "not_installed"
		} else {
			row["pathPresent"] = true
		}
		if path != "" {
			row["pathPresent"] = true
		}
		targets = append(targets, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"targets": targets})
	return true
}

func (a *API) handleNativeLaunch(w http.ResponseWriter, r *http.Request) bool {
	var body struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &body) {
		return true
	}
	if a.loopback == nil || !a.loopback() {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "reason": "loopback_required", "message": "launching local applications requires a proven loopback listener"})
		return true
	}
	target, ok := nativeLaunchTargetByID(body.ID)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown launch target")
		return true
	}
	path, ok := resolveNativeLaunchTarget(target)
	if !ok {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "target_unavailable", "message": "launch target is not installed"})
		return true
	}
	cmd := exec.Command(path)
	if runtime.GOOS == "windows" {
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".cmd" || ext == ".bat" {
			terminal, terminalErr := exec.LookPath("wt.exe")
			if terminalErr != nil {
				writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "needs-windows-terminal", "message": "Windows Terminal is required for batch launch targets"})
				return true
			}
			cmd = exec.Command(terminal, path)
		}
	}
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "reason": "launch_failed", "message": "launch target could not be started"})
		return true
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": target.ID, "pid": cmd.Process.Pid})
	go func() { _ = cmd.Wait() }()
	return true
}

type nativeLaunchTarget struct {
	ID, Label, InstallURL string
	Kind                  string
	Names                 []string
}

func nativeLaunchTargets() []nativeLaunchTarget {
	return []nativeLaunchTarget{{"codex-cli", "Codex CLI", "https://developers.openai.com/codex/cli", "cli", []string{"codex.exe", "codex.cmd", "codex.bat", "codex"}}, {"claude-cli", "Claude Code", "https://claude.com/claude-code", "cli", []string{"claude.exe", "claude.cmd", "claude.bat", "claude"}}, {"grok-cli", "Grok CLI", "https://github.com/superagent-ai/grok-cli", "cli", []string{"grok.exe", "grok.cmd", "grok.bat", "grok"}}, {"chatgpt-desktop", "ChatGPT", "https://openai.com/chatgpt/download/", "desktop", []string{"ChatGPT.exe"}}, {"claude-desktop", "Claude", "https://claude.com/download", "desktop", []string{"Claude.exe"}}, {"grok-desktop", "Grok", "https://grok.com/download", "desktop", []string{"Grok.exe"}}}
}
func nativeLaunchTargetByID(id string) (nativeLaunchTarget, bool) {
	for _, target := range nativeLaunchTargets() {
		if target.ID == id {
			return target, true
		}
	}
	return nativeLaunchTarget{}, false
}
func resolveNativeLaunchTarget(target nativeLaunchTarget) (string, bool) {
	for _, name := range target.Names {
		if path, err := exec.LookPath(name); err == nil && path != "" {
			return path, true
		}
	}
	return "", false
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
	return host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func csvEscape(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }
func htmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(value)
}
func xmlEscape(value string) string { return htmlEscape(value) }
