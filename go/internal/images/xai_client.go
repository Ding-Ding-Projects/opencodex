package images

// xAI image generation and editing client, ported from src/images/xai-client.ts.
//
// Non-2xx responses keep their original status code rather than being folded
// into a 502, so a caller can tell a rate limit from an auth failure from a
// transient error and react differently to each.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	xaiImagesTimeout = 60 * time.Second
	xaiDefaultModel  = "grok-imagine-image-quality"
	// maxXaiResponseBytes stops a runaway response from exhausting memory
	// before the materialization caps downstream can apply.
	maxXaiResponseBytes = 200 * 1024 * 1024
)

// XaiImageRequest is one generation or edit.
type XaiImageRequest struct {
	Prompt string
	// Model is a pointer for the same reason N is: the oracle defaults with ??
	// rather than ||, so an explicitly empty model is a real request and must
	// not be replaced by the PAID default the caller did not ask for.
	Model *string
	// N is a pointer so an explicit 0 survives; the oracle defaults with ??,
	// not ||, so zero is a real value rather than "unset".
	N       *int
	Size    string
	Quality string
	// ImageURL switches the call to /images/edits when set.
	ImageURL string
}

// XaiImage is one returned image, either inline or by URL.
type XaiImage struct {
	B64JSON string `json:"b64_json,omitempty"`
	URL     string `json:"url,omitempty"`
}

// XaiStatusError carries the upstream status so callers can classify it.
type XaiStatusError struct {
	Status int
}

func (e *XaiStatusError) Error() string {
	return "xAI images API returned " + strconv.Itoa(e.Status)
}

// xaiAspectRatios are the only ratios xAI accepts.
var xaiAspectRatios = []struct {
	Label string
	Ratio float64
}{
	{"1:1", 1},
	{"3:4", 0.75},
	{"4:3", 4.0 / 3.0},
	{"9:16", 0.5625},
	{"16:9", 16.0 / 9.0},
}

var xaiSizePattern = regexp.MustCompile(`^(\d+)x(\d+)$`)

// mapSizeToAspectRatio converts OpenAI's WxH to the closest xAI ratio.
//
// Distance is measured in LOG space so the choice is symmetric: 4:3 and 3:4 sit
// equally far from 1:1, which a plain difference would get wrong. An
// unrecognized size is DROPPED rather than forwarded, because xAI rejects
// parameters it does not know and the whole call would fail.
//
// Degenerate numbers follow the oracle rather than being rejected, because the
// oracle has no guard against them and the results are reachable: a zero height
// makes the ratio Infinity or NaN, whose log comparisons are all false, so the
// FIRST candidate wins and the answer is 1:1. A value too large for an int
// parses as a float there and lands on 16:9.
func mapSizeToAspectRatio(size string) string {
	match := xaiSizePattern.FindStringSubmatch(size)
	if match == nil {
		return ""
	}
	// Parsed as floats, matching parseInt's behaviour on values beyond int
	// range: it yields a finite float rather than failing.
	width, errWidth := strconv.ParseFloat(match[1], 64)
	height, errHeight := strconv.ParseFloat(match[2], 64)
	if errWidth != nil || errHeight != nil {
		return ""
	}
	ratio := width / height
	best, bestDiff := xaiAspectRatios[0].Label, math.Inf(1)
	for _, candidate := range xaiAspectRatios {
		diff := math.Abs(math.Log(ratio / candidate.Ratio))
		// NaN comparisons are all false, so a degenerate ratio leaves the
		// first candidate in place exactly as the oracle's loop does.
		if diff < bestDiff {
			best, bestDiff = candidate.Label, diff
		}
	}
	return best
}

// mapQualityToResolution converts OpenAI quality buckets to xAI resolutions.
// Unknown values are dropped for the same reason sizes are.
func mapQualityToResolution(quality string) string {
	switch strings.ToLower(quality) {
	case "hd", "high":
		return "2k"
	case "standard", "low", "auto":
		return "1k"
	}
	return ""
}

// CallXaiImages performs one generation or edit.
//
// The deadline covers the ENTIRE response body read, not just the headers, so a
// stalled upstream cannot hold the request open past the budget.
func CallXaiImages(
	ctx context.Context, client *http.Client, request XaiImageRequest, auth BridgeAuth, timeout time.Duration,
) ([]XaiImage, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if timeout <= 0 {
		timeout = xaiImagesTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	edit := request.ImageURL != ""
	endpoint := "/images/generations"
	if edit {
		endpoint = "/images/edits"
	}

	model := xaiDefaultModel
	if request.Model != nil {
		model = *request.Model
	}
	// N is a pointer so an explicit 0 is distinguishable from an absent value:
	// the oracle uses ?? and therefore sends 0 when 0 was asked for.
	count := 1
	if request.N != nil {
		count = *request.N
	}
	body := map[string]any{"model": model, "prompt": request.Prompt, "n": count}
	if ratio := mapSizeToAspectRatio(request.Size); ratio != "" {
		body["aspect_ratio"] = ratio
	}
	if resolution := mapQualityToResolution(request.Quality); resolution != "" {
		body["resolution"] = resolution
	}
	if edit {
		body["image"] = map[string]any{"url": request.ImageURL, "type": "image_url"}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	target := strings.TrimRight(auth.BaseURL, "/") + endpoint
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	upstream.Header.Set("Authorization", "Bearer "+auth.Token)
	upstream.Header.Set("Content-Type", "application/json")

	response, err := client.Do(upstream)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &XaiStatusError{Status: response.StatusCode}
	}

	// One byte over the cap is read deliberately so the overflow is detectable
	// rather than silently truncating a legitimate response.
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxXaiResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxXaiResponseBytes {
		return nil, fmt.Errorf("xAI images API response exceeds size cap")
	}

	var decoded struct {
		Data []XaiImage `json:"data"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, err
	}
	// A missing data array is an empty result, not an error: the oracle maps
	// over `json.data ?? []`.
	if decoded.Data == nil {
		return []XaiImage{}, nil
	}
	return decoded.Data, nil
}
