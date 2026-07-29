package management

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/storage"
)

// nonNilRestoredPaths keeps an empty result serializing as [] rather than null,
// which the dashboard iterates directly.
func nonNilRestoredPaths(paths []string) []string {
	if paths == nil {
		return []string{}
	}
	return paths
}

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
	case "POST /api/storage/trash/restore":
		a.restoreTrashEntry(w, r)
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

// restoreDefaultBusyTimeoutMS matches the oracle's SQLite wait budget for a
// restore. Long enough that a momentary Codex write does not fail the request,
// short enough that a genuinely busy database answers instead of hanging.
const restoreDefaultBusyTimeoutMS = 100

// restoreErrorStatus maps a restore failure to the status the oracle returns
// (logs-usage-routes.ts:383-393). These are NOT interchangeable: 409 means try
// again after closing Codex, 404 means the entry is gone, 400 means the id was
// wrong. Collapsing them to 500 would tell the user to retry something that
// cannot succeed.
func restoreErrorStatus(code storage.RestoreErrorCode) int {
	switch code {
	case storage.RestoreCodexBusy, storage.RestoreDestExists:
		return http.StatusConflict
	case storage.RestoreMissingTrash:
		return http.StatusNotFound
	case storage.RestoreInvalidTrash:
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

func restoreErrorMessage(code storage.RestoreErrorCode) string {
	switch code {
	case storage.RestoreInvalidTrash:
		return "Trash entry id is missing or invalid."
	case storage.RestoreMissingTrash:
		return "Trash entry was not found."
	case storage.RestoreCodexBusy:
		return "Codex is using state.sqlite — try again after quitting Codex."
	case storage.RestoreDestExists:
		return "Restore destination already exists — remove or rename the archived file and retry."
	case storage.RestoreFSFailed:
		return "Filesystem restore failed. Some files may already be restored — check archived_sessions and .trash."
	case storage.RestoreDBReconcileFailed:
		return "Could not restore Codex state database rows."
	default:
		return "Restore failed."
	}
}

// restoreTrashEntry puts a quarantined session back.
//
// The mutation slot is taken for the whole restore: a cleanup running at the
// same time would be moving the very files this is moving back.
func (a *API) restoreTrashEntry(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": string(storage.RestoreInvalidTrash), "message": "Trash entry id is required.",
		})
		return
	}

	var result storage.RestoreResult
	err := storage.Mutations().WithSlot(storage.MutationRestore, storage.Home(a.storageHome), func() error {
		result = storage.RestoreTrashEntry(strings.TrimSpace(body.ID), a.storageHome, restoreDefaultBusyTimeoutMS, nil)
		return nil
	})
	if err != nil {
		if storage.IsMutationBusy(err) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":   "storage_mutation_busy",
				"message": "Another storage cleanup or restore is in progress — try again shortly.",
			})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "restore_failed", "message": restoreErrorMessage(""),
		})
		return
	}

	if !result.OK {
		code := result.Error
		if code == "" {
			code = "restore_failed"
		}
		payload := map[string]any{
			"ok": false, "error": string(code), "message": restoreErrorMessage(code),
			"count": result.Count, "bytes": result.Bytes, "restoredPaths": nonNilRestoredPaths(result.RestoredPaths),
		}
		if result.TrashDir != "" {
			payload["trashDir"] = result.TrashDir
		}
		writeJSON(w, restoreErrorStatus(code), payload)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "trashDir": result.TrashDir, "count": result.Count,
		"bytes": result.Bytes, "restoredPaths": nonNilRestoredPaths(result.RestoredPaths),
	})
}

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
