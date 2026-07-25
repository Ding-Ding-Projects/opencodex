package server

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleModels(w http.ResponseWriter, _ *http.Request) {
	if s.config.Registry == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "model registry is not configured")
		return
	}
	models := s.config.Registry.ListModels()
	data := make([]map[string]any, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		id := model.ID
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		data = append(data, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": model.Provider})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
}

func unknownV1(w http.ResponseWriter, request *http.Request) {
	writeJSONError(w, http.StatusNotFound, "not_found", "Unknown endpoint: "+request.Method+" "+request.URL.Path)
}
