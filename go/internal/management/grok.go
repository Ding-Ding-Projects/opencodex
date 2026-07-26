package management

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/grok"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type grokCandidateModel struct {
	ID            string `json:"id"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	Native        bool   `json:"native"`
}

type grokStatusModel struct {
	Alias         string `json:"alias"`
	ID            string `json:"id"`
	ContextWindow int    `json:"contextWindow,omitempty"`
}

type grokStatus struct {
	ConfigPath string            `json:"configPath"`
	Present    bool              `json:"present"`
	BaseURL    *string           `json:"baseUrl"`
	Models     []grokStatusModel `json:"models"`
}

func (a *API) handleGrok(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/grok":
		if r.Method != http.MethodGet {
			return false
		}
		status := readGrokStatus()
		statusDTO := map[string]any{"configPath": status.ConfigPath, "present": status.Present, "baseUrl": status.BaseURL, "models": status.Models, "candidates": a.grokCandidates()}
		a.mu.RLock()
		statusDTO["excluded"] = append([]string(nil), a.config.GrokExcludedModels...)
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, statusDTO)
		return true
	case "/api/grok/selection":
		if r.Method != http.MethodPut {
			return false
		}
		var body struct {
			Excluded json.RawMessage `json:"excluded"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		var requested []string
		if len(body.Excluded) == 0 || string(body.Excluded) == "null" || json.Unmarshal(body.Excluded, &requested) != nil {
			writeError(w, http.StatusBadRequest, "excluded must be an array of model ids")
			return true
		}
		if len(requested) > 2000 {
			writeError(w, http.StatusBadRequest, "excluded list is too large")
			return true
		}
		seen := make(map[string]struct{}, len(requested))
		excluded := make([]string, 0, len(requested))
		for _, id := range requested {
			if id == "" {
				writeError(w, http.StatusBadRequest, "excluded must be an array of model ids")
				return true
			}
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			excluded = append(excluded, id)
		}
		sort.Strings(excluded)
		a.mu.Lock()
		previous := append([]string(nil), a.config.GrokExcludedModels...)
		a.config.GrokExcludedModels = excluded
		err := a.saveLocked()
		if err != nil {
			a.config.GrokExcludedModels = previous
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save Grok selection failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "excluded": excluded})
		return true
	case "/api/grok/apply":
		if r.Method != http.MethodPost {
			return false
		}
		a.applyGrok(w, r)
		return true
	}
	return false
}

func (a *API) grokCandidates() []grokCandidateModel {
	a.mu.RLock()
	cfg := *a.config
	a.mu.RUnlock()
	if a.registry == nil {
		return []grokCandidateModel{}
	}
	models := codex.FilterVisibleRuntimeModels(a.registry.ListModels(), cfg)
	result := make([]grokCandidateModel, 0, len(models))
	for _, model := range models {
		result = append(result, grokCandidateModel{ID: model.ID, ContextWindow: model.ContextWindow, Native: model.Provider == "openai" && !strings.Contains(model.ID, "/")})
	}
	return result
}

func (a *API) applyGrok(w http.ResponseWriter, r *http.Request) {
	a.grokApplyMu.Lock()
	defer a.grokApplyMu.Unlock()
	a.mu.RLock()
	port, hostname := a.grokPort, a.grokHostname
	if port <= 0 {
		port = a.config.Port
	}
	if hostname == "" {
		hostname = a.config.Host
	}
	excluded := stringSet(a.config.GrokExcludedModels)
	a.mu.RUnlock()
	result := grok.SyncGrokConfig(r.Context(), port, grok.Options{Hostname: hostname, Excluded: excluded}, grok.SyncDeps{FetchModels: func(context.Context) ([]grok.InjectModel, error) {
		candidates := a.grokCandidates()
		models := make([]grok.InjectModel, 0, len(candidates))
		for _, model := range candidates {
			models = append(models, grok.InjectModel{ID: model.ID, ContextWindow: model.ContextWindow})
		}
		return models, nil
	}})
	status := http.StatusOK
	if !result.OK {
		status = http.StatusInternalServerError
	}
	payload := map[string]any{"ok": result.OK, "changed": result.Changed, "message": result.Message}
	if result.SkippedReason != "" {
		payload["skippedReason"] = result.SkippedReason
	}
	writeJSON(w, status, payload)
}

func stringSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func readGrokStatus() grokStatus {
	home := os.Getenv("GROK_HOME")
	if home == "" {
		userHome, _ := os.UserHomeDir()
		home = filepath.Join(userHome, ".grok")
	}
	path := filepath.Join(home, "config.toml")
	content, err := os.ReadFile(path)
	if err != nil {
		return grokStatus{ConfigPath: path, BaseURL: nil, Models: []grokStatusModel{}}
	}
	text := string(content)
	begin := strings.Index(text, grok.BeginMarker)
	end := -1
	if begin >= 0 {
		if relative := strings.Index(text[begin+len(grok.BeginMarker):], grok.EndMarker); relative >= 0 {
			end = begin + len(grok.BeginMarker) + relative
		}
	}
	if begin < 0 || end < begin {
		return grokStatus{ConfigPath: path, BaseURL: nil, Models: []grokStatusModel{}}
	}
	region := text[begin+len(grok.BeginMarker) : end]
	status := grokStatus{ConfigPath: path, Present: true, Models: []grokStatusModel{}}
	var current *grokStatusModel
	scanner := bufio.NewScanner(strings.NewReader(region))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[model.") && strings.HasSuffix(line, "]") {
			status.Models = append(status.Models, grokStatusModel{Alias: strings.TrimSuffix(strings.TrimPrefix(line, "[model."), "]")})
			current = &status.Models[len(status.Models)-1]
			continue
		}
		if current == nil {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.Trim(strings.TrimSpace(value), `"`)
		switch key {
		case "model":
			current.ID = value
		case "base_url":
			if status.BaseURL == nil {
				baseURL := value
				status.BaseURL = &baseURL
			}
		case "context_window":
			current.ContextWindow, _ = strconv.Atoi(value)
		}
	}
	filtered := status.Models[:0]
	for _, model := range status.Models {
		if model.ID != "" {
			filtered = append(filtered, model)
		}
	}
	status.Models = filtered
	return status
}

var _ types.ManagementRouter = (*API)(nil)
