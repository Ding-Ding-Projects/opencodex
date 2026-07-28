package images

// Image-bridge loop bounds and single-call fulfillment, ported from
// src/images/loop.ts and src/images/fulfill.ts.
//
// Every bound here exists because the calls behind them are PAID. A round limit
// that can be raised without limit, or a fulfillment that throws instead of
// reporting, both turn a bad argument into recurring spend.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// DefaultMaxRounds is the image-generation loop budget when unset.
	DefaultMaxRounds = 3
	// MaxRoundsHardLimit is an absolute ceiling, so a hand-edited
	// `images.maxRounds: 10000` cannot unbound paid xAI calls.
	MaxRoundsHardLimit = 10
)

// ClampImageMaxRounds bounds a configured round budget to [0, 10].
//
// A non-numeric or non-finite value falls back to the default rather than to
// zero: an unreadable setting should behave like an absent one, not silently
// disable the feature.
func ClampImageMaxRounds(value *float64) int {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return DefaultMaxRounds
	}
	floored := math.Floor(*value)
	if floored < 0 {
		return 0
	}
	if floored > MaxRoundsHardLimit {
		return MaxRoundsHardLimit
	}
	return int(floored)
}

// ImageCallResult is the outcome of one image tool call, shaped so a failure is
// still something the model can read and answer to.
type ImageCallResult struct {
	OK       bool
	Model    string
	Prompt   string
	Path     string
	Files    []string
	Count    int
	Markdown string
	Error    string
}

// ImageToolCall is the model's request.
type ImageToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// imageCallArgs is the parsed argument set.
type imageCallArgs struct {
	Prompt   string
	N        int
	ImageURL string
	Size     string
	Quality  string
}

// parseImageCallArgs mirrors the oracle's branch order exactly.
//
// The order matters: `prompt` wins over `input`, but only when it is actually a
// string, so a numeric prompt falls through to `input` rather than failing. An
// array parses as an object in JavaScript and therefore reaches the
// missing-prompt branch instead of the invalid-JSON one.
func parseImageCallArgs(raw string, plan Plan) (imageCallArgs, error) {
	// Only a genuinely absent argument string becomes "{}". Whitespace is NOT
	// trimmed first: the oracle passes " " to JSON.parse, which rejects it, so
	// trimming here would turn an invalid-JSON refusal into a missing-prompt
	// one and report the wrong thing to the model.
	if raw == "" {
		raw = "{}"
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return imageCallArgs{}, errors.New("invalid arguments JSON")
	}
	fields := map[string]any{}
	switch typed := decoded.(type) {
	case map[string]any:
		fields = typed
	case []any:
		// An array is an object to the oracle: no prompt field, so it lands on
		// the missing-prompt error rather than the parse error.
	default:
		// null, numbers, strings and booleans are all rejected as invalid.
		return imageCallArgs{}, errors.New("invalid arguments JSON")
	}

	// The fallback is on TYPE, not on emptiness. A present-but-empty prompt
	// wins over input and then fails the missing-prompt check, which is what
	// stops an empty primary field from quietly triggering a PAID call with
	// somebody else's text.
	prompt, isString := fields["prompt"].(string)
	if !isString {
		prompt, _ = fields["input"].(string)
	}
	if prompt == "" {
		return imageCallArgs{}, errors.New("missing prompt")
	}

	// Clamped to 1..4 and floored. A request for zero images is a request for
	// one, matching the oracle, rather than a call that spends nothing and
	// returns nothing.
	count := 1
	if raw, ok := fields["n"].(float64); ok {
		count = int(math.Max(1, math.Min(4, math.Floor(raw))))
	}

	// Same rule: an empty image_url is still a chosen image_url, so the call
	// stays a generation rather than silently becoming an edit against a
	// fallback URL the caller did not select.
	imageURL, isString := fields["image_url"].(string)
	if !isString {
		imageURL, _ = fields["image"].(string)
	}
	size, ok := fields["size"].(string)
	if !ok {
		size = plan.DefaultSize
	}
	quality, ok := fields["quality"].(string)
	if !ok {
		quality = plan.DefaultQuality
	}
	return imageCallArgs{Prompt: prompt, N: count, ImageURL: imageURL, Size: size, Quality: quality}, nil
}

// retentionChain serializes write-then-prune across concurrent fulfillments
// sharing one artifacts directory, so they cannot prune each other's
// just-written paths mid-filter.
var retentionChain sync.Mutex

// retainAfterBatch prunes only after the WHOLE batch is on disk.
//
// Pruning per image would let a tight keep count delete an earlier image from
// the same call before its path was ever returned.
func retainAfterBatch(dir string, paths []string, keepCount int, hasKeepCount bool) []string {
	retentionChain.Lock()
	defer retentionChain.Unlock()
	if hasKeepCount {
		PruneOldArtifacts(dir, keepCount)
	} else {
		PruneOldArtifacts(dir, DefaultArtifactKeepCount)
	}
	retained := make([]string, 0, len(paths))
	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			retained = append(retained, path)
		}
	}
	return retained
}

// FulfillImageCall runs one image tool call end to end.
//
// It NEVER returns an error. Every failure becomes a result the caller injects
// as a tool result, so the model can respond to it instead of the turn dying on
// an exception the user never sees.
func FulfillImageCall(
	ctx context.Context, dir string, call ImageToolCall, plan Plan, budget *ImageBudget,
	lookup IPLookup, download PinnedDownload, client XaiCaller,
) ImageCallResult {
	args, err := parseImageCallArgs(call.Arguments, plan)
	if err != nil {
		return ImageCallResult{Model: plan.Model, Files: []string{}, Error: err.Error()}
	}

	images, err := client(ctx, XaiImageRequest{
		Prompt: args.Prompt, Model: &plan.Model, N: &args.N,
		Size: args.Size, Quality: args.Quality, ImageURL: args.ImageURL,
	}, plan.Auth, planTimeout(plan))
	if err != nil {
		return ImageCallResult{Model: plan.Model, Prompt: args.Prompt, Files: []string{}, Error: err.Error()}
	}

	files := make([]string, 0, len(images))
	for _, image := range images {
		var path string
		var writeErr error
		switch {
		case image.B64JSON != "":
			path, writeErr = MaterializeInlineImage(dir, image.B64JSON, budget)
		case image.URL != "":
			path, writeErr = DownloadImageToArtifact(ctx, dir, image.URL, budget, lookup, download)
		default:
			continue
		}
		// Partial success is fine: one bad image out of four should not lose
		// the other three. The error is deliberately not surfaced, because it
		// can embed a provider CDN URL.
		if writeErr == nil {
			files = append(files, path)
		}
	}

	retained := retainAfterBatch(dir, files, plan.ArtifactsKeepCount, plan.HasArtifactsKeepCount)
	if len(retained) == 0 {
		return ImageCallResult{
			Model: plan.Model, Prompt: args.Prompt, Files: []string{},
			Error: "image generation returned no usable images",
		}
	}

	primary := retained[0]
	return ImageCallResult{
		OK: true, Model: plan.Model, Prompt: args.Prompt, Path: primary,
		Files: retained, Count: len(retained),
		// A file URI, not a bare path: Windows backslashes would otherwise be
		// read as escapes by a Markdown renderer.
		Markdown: "![image](" + fileURI(primary) + ")",
	}
}

// XaiCaller is the generation transport, injected so tests never spend money.
type XaiCaller func(context.Context, XaiImageRequest, BridgeAuth, time.Duration) ([]XaiImage, error)

func fileURI(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
}

// planTimeout converts the plan's millisecond budget, letting the client apply
// its own default when unset.
func planTimeout(plan Plan) time.Duration {
	if plan.TimeoutMS <= 0 {
		return 0
	}
	return time.Duration(plan.TimeoutMS) * time.Millisecond
}
