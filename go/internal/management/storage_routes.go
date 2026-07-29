package management

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/storage"
)

// Storage management routes. The domain layer was ported first and left unreachable: the
// dashboard's Storage page calls these paths and every one of them answered 404, so a user
// could not list what was quarantined, preview a cleanup, or configure the policy.

func (a *API) handleStorageRoutes(w http.ResponseWriter, r *http.Request) bool {
	switch r.Method + " " + r.URL.Path {
	case "POST /api/storage/cleanup/preview":
		a.previewStorageCleanup(w, r)
	case "GET /api/storage/trash":
		entries := storage.ListTrashEntries(a.storageHome)
		writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
	case "GET /api/storage/cleanup-policy":
		a.mu.RLock()
		policy := storage.NormalizeStorageCleanupPolicy(a.storageCleanupPolicyLocked())
		a.mu.RUnlock()
		writeJSON(w, http.StatusOK, policy)
	case "PUT /api/storage/cleanup-policy":
		a.putStorageCleanupPolicy(w, r)
	case "GET /api/storage/cleanup-policy/test-stream", "GET /api/storage/trash/restore/test-stream":
		// Test-only streaming surfaces. The oracle exposes them for its responsiveness tests;
		// answering a flat not-found is honest until those tests are ported, and it keeps the
		// route table complete so a caller learns the difference between "unsupported here"
		// and "unknown endpoint".
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_available"})
	default:
		return false
	}
	return true
}

// storageCleanupPolicyLocked reads the policy as stored. It lives in the config passthrough
// rather than a typed field, which is how a Go build preserves a key it does not model.
func (a *API) storageCleanupPolicyLocked() any {
	raw, ok := a.config.ExtraFields["storageCleanupPolicy"]
	if !ok {
		return nil
	}
	// Decoded with UseNumber for the same reason the write path uses it: the normalizer reads
	// numbers as json.Number, and a float64 would normalize every threshold back to default.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil
	}
	return decoded
}

func (a *API) previewStorageCleanup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Percent *float64 `json:"percent"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Percent == nil || *body.Percent < 0 || *body.Percent > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_percent"})
		return
	}
	preview, err := storage.PreviewArchivedCleanup(a.storageHome, *body.Percent)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage preview failed")
		return
	}
	writeJSON(w, http.StatusOK, projectCleanupPreview(preview))
}

func (a *API) putStorageCleanupPolicy(w http.ResponseWriter, r *http.Request) {
	// The policy parser validates numbers as json.Number so a fractional byte count is
	// rejected rather than silently truncated, which the default float64 decode would hide.
	r.Body = http.MaxBytesReader(w, r.Body, maxManagementBody)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	var raw any
	if err := decoder.Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	a.mu.Lock()
	previous := storage.NormalizeStorageCleanupPolicy(a.storageCleanupPolicyLocked())
	policy, problem := storage.ParseStorageCleanupPolicyInput(raw, &previous, float64(a.now().UnixMilli()))
	if problem != "" {
		a.mu.Unlock()
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		a.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "encode cleanup policy failed")
		return
	}
	if a.config.ExtraFields == nil {
		a.config.ExtraFields = map[string]json.RawMessage{}
	}
	a.config.ExtraFields["storageCleanupPolicy"] = encoded
	saveErr := a.saveLocked()
	a.mu.Unlock()
	if saveErr != nil {
		writeError(w, http.StatusInternalServerError, "save cleanup policy failed")
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

// projectCleanupPreview strips the host paths the domain type carries for its own bookkeeping.
// codexHome and absPath identify a machine, and count/bytes/digest already bind the full set,
// so the wire answer names only what the dashboard renders (oracle:
// src/server/management/logs-usage-routes.ts:257-269). The list is capped at 50 for the same
// reason the oracle caps it: the digest, not the listing, is what a later cleanup is checked
// against.
func projectCleanupPreview(preview storage.CleanupPreview) orderedJSONObject {
	candidates := make([]orderedJSONObject, 0, len(preview.Candidates))
	for index, candidate := range preview.Candidates {
		if index >= 50 {
			break
		}
		candidates = append(candidates, orderedJSONObject{
			{name: "relPath", value: candidate.RelPath},
			{name: "bytes", value: candidate.Bytes},
			{name: "mtimeMs", value: candidate.MtimeMS},
			{name: "physicalRelPaths", value: candidate.PhysicalRelPaths()},
		})
	}
	return orderedJSONObject{
		{name: "percent", value: preview.Percent},
		{name: "count", value: preview.Count},
		{name: "bytes", value: preview.Bytes},
		{name: "digest", value: preview.Digest},
		{name: "candidates", value: candidates},
	}
}
