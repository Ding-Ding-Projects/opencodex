package grok

import "context"

// Fence is the lifecycle boundary the CLI uses after an observed proxy becomes
// healthy. Ensure and Restart intentionally run the same catalog sync so the fence
// is deterministic before either command returns. The generated entries pin
// chat_completions because Grok's strict Responses decoder must never receive raw
// response.heartbeat frames.
type Fence struct {
	Port        int
	Hostname    string
	GrokHome    string
	FetchModels FetchModelsFunc
}

func (f Fence) Ensure(ctx context.Context) Result {
	return f.sync(ctx)
}

func (f Fence) Restart(ctx context.Context) Result {
	return f.sync(ctx)
}

func (f Fence) Teardown() Result {
	return StripGrokConfig(Options{GrokHome: f.GrokHome})
}

func (f Fence) sync(ctx context.Context) Result {
	return SyncGrokConfig(ctx, f.Port, Options{GrokHome: f.GrokHome, Hostname: f.Hostname}, SyncDeps{FetchModels: f.FetchModels})
}
