package server

import (
	"encoding/json"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func backfillGoogleModes(cfg *appconfig.Config) {
	if cfg == nil {
		return
	}
	for name, configured := range cfg.Providers {
		mode := providers.EffectiveGoogleMode(name, providers.ProviderConfig{Adapter: configured.Adapter, GoogleMode: configured.GoogleMode})
		if mode != "" && configured.GoogleMode == "" {
			configured.GoogleMode = mode
			cfg.Providers[name] = configured
		}
	}
}

func applyProviderPolicies(request *types.NormalizedRequest, resolved *types.ResolvedModel) error {
	if request == nil || resolved == nil {
		return nil
	}
	var raw map[string]any
	if len(request.RawBody) > 0 {
		if err := json.Unmarshal(request.RawBody, &raw); err != nil {
			return err
		}
	}
	virtual := &providers.VirtualRequest{ModelID: request.ModelID, RawBody: raw}
	route := &providers.RouteResult{ProviderName: resolved.Provider, ModelID: resolved.Model}
	log := &providers.RequestLogContext{Model: request.ModelID}
	_, applied, err := providers.ApplyOpenAIVirtualModel(virtual, route, log)
	if err != nil || !applied {
		return err
	}
	request.ModelID = route.ModelID
	resolved.Model = route.ModelID
	if raw != nil {
		updated, marshalErr := json.Marshal(raw)
		if marshalErr != nil {
			return marshalErr
		}
		request.RawBody = updated
	}
	return nil
}
