package images

// Differential against src/images/loop.ts and src/images/fulfill.ts. Every
// expectation was captured by RUNNING the oracle.

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func roundsPointer(value float64) *float64 { return &value }

// Oracle: the clamp is what stops a hand-edited maxRounds from unbounding paid
// calls, and an unreadable value falls back to the DEFAULT rather than to zero,
// so a typo does not silently disable the feature.
func TestClampImageMaxRoundsMatchesTheOracle(t *testing.T) {
	if got := ClampImageMaxRounds(nil); got != DefaultMaxRounds {
		t.Fatalf("absent = %d, oracle returns %d", got, DefaultMaxRounds)
	}
	for _, testCase := range []struct {
		value float64
		want  int
	}{
		{-1, 0},
		{0, 0},
		// Floored, so a fraction below one becomes zero rather than one.
		{0.9, 0},
		{3.7, 3},
		{10, 10},
		{11, MaxRoundsHardLimit},
		{10000, MaxRoundsHardLimit},
		{2, 2},
	} {
		if got := ClampImageMaxRounds(roundsPointer(testCase.value)); got != testCase.want {
			t.Fatalf("clamp(%v) = %d, oracle returns %d", testCase.value, got, testCase.want)
		}
	}
}

func argsPlan() Plan {
	return Plan{Model: "m", DefaultSize: "1024x1024", DefaultQuality: "high"}
}

// Oracle: argument parsing, including the branch order that is easy to get
// wrong. `prompt` wins over `input` only when it is actually a string; an array
// reaches the missing-prompt branch rather than the invalid-JSON one; null and
// scalars are invalid JSON arguments.
func TestParseImageCallArgsMatchesTheOracle(t *testing.T) {
	plan := argsPlan()
	for _, testCase := range []struct {
		name, raw, wantErr, wantPrompt string
	}{
		{"empty string", "", "missing prompt", ""},
		{"empty object", "{}", "missing prompt", ""},
		{"malformed", "{oops", "invalid arguments JSON", ""},
		{"array", "[1,2]", "missing prompt", ""},
		{"null", "null", "invalid arguments JSON", ""},
		{"scalar", "5", "invalid arguments JSON", ""},
		{"prompt", `{"prompt":"a"}`, "", "a"},
		{"input fallback", `{"input":"b"}`, "", "b"},
		{"prompt wins", `{"prompt":"a","input":"b"}`, "", "a"},
		{"empty prompt falls through", `{"prompt":""}`, "missing prompt", ""},
		// A non-string prompt falls through to input rather than failing.
		{"numeric prompt", `{"prompt":5,"input":"b"}`, "", "b"},
	} {
		args, err := parseImageCallArgs(testCase.raw, plan)
		if testCase.wantErr != "" {
			if err == nil || err.Error() != testCase.wantErr {
				t.Fatalf("%s: err = %v, oracle returns %q", testCase.name, err, testCase.wantErr)
			}
			continue
		}
		if err != nil || args.Prompt != testCase.wantPrompt {
			t.Fatalf("%s: args = %#v err = %v", testCase.name, args, err)
		}
	}
}

// Oracle: n is clamped to 1..4 and floored, and a non-numeric n is ignored
// rather than treated as zero.
func TestParseImageCallArgsClampsTheCount(t *testing.T) {
	plan := argsPlan()
	for _, testCase := range []struct {
		raw  string
		want int
	}{
		{`{"prompt":"a","n":0}`, 1},
		{`{"prompt":"a","n":9}`, 4},
		{`{"prompt":"a","n":2.7}`, 2},
		{`{"prompt":"a","n":"3"}`, 1},
		{`{"prompt":"a"}`, 1},
	} {
		args, err := parseImageCallArgs(testCase.raw, plan)
		if err != nil || args.N != testCase.want {
			t.Fatalf("%s: n = %d err = %v, oracle returns %d", testCase.raw, args.N, err, testCase.want)
		}
	}
}

// Oracle: image_url wins over image, and size and quality fall back to the
// plan's hosted defaults when the call does not name them.
func TestParseImageCallArgsAppliesPlanDefaults(t *testing.T) {
	plan := argsPlan()
	args, _ := parseImageCallArgs(`{"prompt":"a","image_url":"u","image":"v"}`, plan)
	if args.ImageURL != "u" {
		t.Fatalf("image url = %q, oracle prefers image_url", args.ImageURL)
	}
	fallback, _ := parseImageCallArgs(`{"prompt":"a","image":"v"}`, plan)
	if fallback.ImageURL != "v" {
		t.Fatalf("image fallback = %q", fallback.ImageURL)
	}
	defaults, _ := parseImageCallArgs(`{"prompt":"a"}`, plan)
	if defaults.Size != "1024x1024" || defaults.Quality != "high" {
		t.Fatalf("defaults = %q/%q", defaults.Size, defaults.Quality)
	}
	override, _ := parseImageCallArgs(`{"prompt":"a","size":"512x512"}`, plan)
	if override.Size != "512x512" || override.Quality != "high" {
		t.Fatalf("override = %q/%q", override.Size, override.Quality)
	}
}

func inlineCaller(images ...XaiImage) XaiCaller {
	return func(context.Context, XaiImageRequest, BridgeAuth, time.Duration) ([]XaiImage, error) {
		return images, nil
	}
}

func failingCaller(message string) XaiCaller {
	return func(context.Context, XaiImageRequest, BridgeAuth, time.Duration) ([]XaiImage, error) {
		return nil, errors.New(message)
	}
}

func encodedPNG() string { return base64.StdEncoding.EncodeToString(pngBytes) }

// Fulfillment NEVER returns an error: every failure becomes a result the caller
// injects as a tool result, so the model can answer instead of the turn dying.
func TestFulfillImageCallReportsFailuresAsResults(t *testing.T) {
	dir := t.TempDir()
	plan := argsPlan()

	badArgs := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: "{oops"}, plan, nil, nil, nil, inlineCaller())
	if badArgs.OK || badArgs.Error != "invalid arguments JSON" || badArgs.Files == nil {
		t.Fatalf("bad args = %#v", badArgs)
	}

	upstream := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a"}`}, plan, nil, nil, nil, failingCaller("xAI images API returned 429"))
	if upstream.OK || upstream.Error != "xAI images API returned 429" || upstream.Prompt != "a" {
		t.Fatalf("upstream = %#v", upstream)
	}

	none := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a"}`}, plan, nil, nil, nil, inlineCaller())
	if none.OK || none.Error != "image generation returned no usable images" {
		t.Fatalf("no images = %#v", none)
	}
}

// A successful call reports every retained file, names the first as primary,
// and renders Markdown with a file URI rather than a bare path, so Windows
// backslashes are not read as escapes.
func TestFulfillImageCallWritesAndReports(t *testing.T) {
	dir := t.TempDir()
	plan := argsPlan()
	result := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a","n":2}`}, plan, nil, nil, nil,
		inlineCaller(XaiImage{B64JSON: encodedPNG()}, XaiImage{B64JSON: encodedPNG()}))
	if !result.OK || result.Count != 2 || len(result.Files) != 2 {
		t.Fatalf("result = %#v", result)
	}
	if result.Path != result.Files[0] {
		t.Fatalf("primary = %q, want the first file", result.Path)
	}
	if !strings.HasPrefix(result.Markdown, "![image](file://") || !strings.HasSuffix(result.Markdown, ")") {
		t.Fatalf("markdown = %q", result.Markdown)
	}
	for _, path := range result.Files {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("reported file missing: %v", err)
		}
	}
}

// Partial success is preserved: one unusable image out of several must not lose
// the others.
func TestFulfillImageCallKeepsPartialSuccess(t *testing.T) {
	dir := t.TempDir()
	result := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a"}`}, argsPlan(), nil, nil, nil,
		inlineCaller(
			XaiImage{B64JSON: "!!!not base64!!!"},
			XaiImage{B64JSON: encodedPNG()},
			XaiImage{},
		))
	if !result.OK || result.Count != 1 {
		t.Fatalf("result = %#v, want the one usable image", result)
	}
}

// Retention runs AFTER the whole batch is written, so a tight keep count cannot
// delete an earlier image from the same call before its path is returned.
func TestFulfillImageCallPrunesAfterTheBatch(t *testing.T) {
	dir := t.TempDir()
	plan := argsPlan()
	// A keep count of ONE is what discriminates: pruning per image would delete
	// each earlier file as the next is written, so only the last would survive
	// and every earlier reported path would be dangling.
	plan.ArtifactsKeepCount = 1
	plan.HasArtifactsKeepCount = true
	lookup := func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("8.8.8.8")}, nil }

	// The caller observes the directory BETWEEN images. Pruning per image would
	// show the count pinned at the keep limit while writing is still in
	// progress; pruning after the batch lets it grow past the limit first, and
	// that transient is the only way to tell the two orderings apart from the
	// outside.
	var duringWrite []int
	result := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a","n":3}`}, plan, nil, lookup,
		func(ctx context.Context, raw string, pinned PinnedAddress) (int, io.ReadCloser, error) {
			entries, _ := os.ReadDir(dir)
			duringWrite = append(duringWrite, len(entries))
			return 200, io.NopCloser(strings.NewReader(string(pngBytes))), nil
		},
		inlineCaller(
			XaiImage{URL: "https://images.example/a.png"},
			XaiImage{URL: "https://images.example/b.png"},
			XaiImage{URL: "https://images.example/c.png"},
		))
	if !result.OK {
		t.Fatalf("result = %#v", result)
	}
	// By the third download, two files are already on disk. Per-image pruning
	// would have kept that count at one.
	if len(duringWrite) != 3 || duringWrite[2] != 2 {
		t.Fatalf("directory sizes during the batch = %v, want the count to grow past the keep limit", duringWrite)
	}
	// Every REPORTED path must still exist: reporting a path that pruning has
	// already deleted would hand the model a broken reference.
	for _, path := range result.Files {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("reported a pruned path %q: %v", filepath.Base(path), err)
		}
	}
	// Exactly one file survives the prune, and it is the one reported.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("directory holds %d files, keep count is 1", len(entries))
	}
	if len(result.Files) != 1 {
		t.Fatalf("reported %d files, only one survived retention", len(result.Files))
	}
}

// A URL image goes through the full download gate, so the SSRF rules apply to
// whatever the provider returns.
func TestFulfillImageCallRoutesURLImagesThroughTheDownloadGate(t *testing.T) {
	dir := t.TempDir()
	lookup := func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("8.8.8.8")}, nil
	}
	download := func(context.Context, string, PinnedAddress) (int, io.ReadCloser, error) {
		return 200, io.NopCloser(strings.NewReader(string(pngBytes))), nil
	}
	result := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a"}`}, argsPlan(), nil, lookup, download,
		inlineCaller(XaiImage{URL: "https://images.example/x.png"}))
	if !result.OK || result.Count != 1 {
		t.Fatalf("result = %#v", result)
	}
	if !strings.HasPrefix(filepath.Base(result.Path), "dl-") {
		t.Fatalf("path = %q, want the download prefix", result.Path)
	}

	// A loopback URL is refused by the same gate, and the call degrades to a
	// reported failure rather than an exception.
	refused := FulfillImageCall(context.Background(), dir,
		ImageToolCall{Arguments: `{"prompt":"a"}`}, argsPlan(), nil, lookup, download,
		inlineCaller(XaiImage{URL: "https://127.0.0.1/x.png"}))
	if refused.OK || refused.Error != "image generation returned no usable images" {
		t.Fatalf("refused = %#v", refused)
	}
}

// Concurrent fulfillments sharing one directory must not prune each other's
// just-written paths mid-filter. The oracle serializes through a promise chain;
// this serializes through a mutex, and the observable requirement is the same:
// every reported path exists when the call returns.
func TestFulfillImageCallSerializesRetention(t *testing.T) {
	dir := t.TempDir()
	plan := argsPlan()
	plan.ArtifactsKeepCount = 4
	plan.HasArtifactsKeepCount = true

	const callers = 6
	results := make(chan ImageCallResult, callers)
	for index := 0; index < callers; index++ {
		go func() {
			results <- FulfillImageCall(context.Background(), dir,
				ImageToolCall{Arguments: `{"prompt":"a","n":2}`}, plan, nil, nil, nil,
				inlineCaller(XaiImage{B64JSON: encodedPNG()}, XaiImage{B64JSON: encodedPNG()}))
		}()
	}
	for index := 0; index < callers; index++ {
		result := <-results
		for _, path := range result.Files {
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("a concurrent fulfillment reported a pruned path: %v", err)
			}
		}
	}
}

// The oracle's fallbacks are TYPE checks, not emptiness checks. A
// present-but-empty primary field wins and then fails validation, which is what
// stops an empty prompt from quietly triggering a paid call with the text from
// a different field.
func TestParseImageCallArgsFallsBackOnTypeNotEmptiness(t *testing.T) {
	plan := argsPlan()

	// An empty prompt does NOT fall through to input.
	_, err := parseImageCallArgs(`{"prompt":"","input":"fallback"}`, plan)
	if err == nil || err.Error() != "missing prompt" {
		t.Fatalf("err = %v, oracle returns missing prompt rather than using the fallback", err)
	}

	// An empty image_url does NOT fall through to image, so the call stays a
	// generation instead of becoming an edit against a URL nobody chose.
	args, err := parseImageCallArgs(`{"prompt":"p","image_url":"","image":"https://f/i.png"}`, plan)
	if err != nil || args.ImageURL != "" {
		t.Fatalf("image url = %q err = %v, oracle keeps the empty image_url", args.ImageURL, err)
	}

	// A MISSING primary field still falls through, which is the case the
	// fallback exists for.
	fallback, err := parseImageCallArgs(`{"input":"b","image":"https://f/i.png"}`, plan)
	if err != nil || fallback.Prompt != "b" || fallback.ImageURL != "https://f/i.png" {
		t.Fatalf("fallback = %#v err = %v", fallback, err)
	}
}

// Whitespace-only arguments are invalid JSON, not an empty object. Trimming
// first would report missing-prompt where the oracle reports a parse failure.
func TestParseImageCallArgsRejectsWhitespaceArguments(t *testing.T) {
	_, err := parseImageCallArgs(" ", argsPlan())
	if err == nil || err.Error() != "invalid arguments JSON" {
		t.Fatalf("err = %v, oracle returns invalid arguments JSON", err)
	}
	// A genuinely absent argument string is still an empty object.
	_, err = parseImageCallArgs("", argsPlan())
	if err == nil || err.Error() != "missing prompt" {
		t.Fatalf("empty string err = %v, oracle treats it as {}", err)
	}
}
