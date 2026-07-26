package grok

import (
	"context"
	"fmt"
)

type FetchModelsFunc func(context.Context) ([]InjectModel, error)

type SyncDeps struct {
	// FetchModels returns the catalog already filtered to models visible to users.
	FetchModels FetchModelsFunc
}

// SyncGrokConfig fetches the current visible catalog and refreshes the managed fence.
func SyncGrokConfig(ctx context.Context, port int, opts Options, deps SyncDeps) Result {
	if deps.FetchModels == nil {
		return Result{Message: "Grok config sync skipped: model catalog unavailable (FetchModels is nil)"}
	}
	models, err := deps.FetchModels(ctx)
	if err != nil {
		return Result{Message: fmt.Sprintf("Grok config sync skipped: model catalog unavailable (%v)", err)}
	}
	return InjectGrokConfig(port, models, opts)
}
