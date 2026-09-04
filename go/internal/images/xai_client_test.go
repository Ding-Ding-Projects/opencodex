package images

// Differential against src/images/xai-client.ts. Every expectation was
// captured by RUNNING the oracle against a stub server.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type capturedRequest struct {
	Path string
	Auth string
	Type string
	Body map[string]any
}

func xaiStub(t *testing.T, response string, status int) (*httptest.Server, *[]capturedRequest) {
	t.Helper()
	captured := &[]capturedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		*captured = append(*captured, capturedRequest{
			Path: r.URL.Path, Auth: r.Header.Get("Authorization"),
			Type: r.Header.Get("Content-Type"), Body: body,
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)
	return server, captured
}

// Oracle X1: defaults, endpoint, headers, and the returned image shape.
func TestCallXaiImagesDefaults(t *testing.T) {
	server, captured := xaiStub(t, `{"data":[{"b64_json":"AAA"},{"url":"https://x/y.png"},{"other":1}]}`, http.StatusOK)
	images, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: server.URL + "/v1", Token: "tok"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 3 || images[0].B64JSON != "AAA" || images[1].URL != "https://x/y.png" {
		t.Fatalf("images = %#v", images)
	}
	// An entry with neither field is preserved as an empty image, matching the
	// oracle's map over every data entry.
	if images[2].B64JSON != "" || images[2].URL != "" {
		t.Fatalf("third image = %#v, oracle keeps it empty", images[2])
	}
	request := (*captured)[0]
	if request.Path != "/v1/images/generations" || request.Auth != "Bearer tok" || request.Type != "application/json" {
		t.Fatalf("request = %#v", request)
	}
	if request.Body["model"] != "grok-imagine-image-quality" || request.Body["prompt"] != "p" || request.Body["n"] != float64(1) {
		t.Fatalf("body = %#v, oracle defaults model and n", request.Body)
	}
	if _, present := request.Body["aspect_ratio"]; present {
		t.Fatal("an unset size still sent aspect_ratio")
	}
}

// Oracle X2-X6: size and quality mapping, including that UNKNOWN values are
// dropped rather than forwarded, since xAI rejects parameters it does not know
// and the whole call would fail.
func TestCallXaiImagesMapsSizeAndQuality(t *testing.T) {
	for _, testCase := range []struct {
		name, size, quality string
		wantRatio           string
		wantResolution      string
	}{
		{"landscape hd", "1024x768", "hd", "4:3", "2k"},
		{"square standard", "512x512", "standard", "1:1", "1k"},
		{"widescreen low", "1920x1080", "low", "16:9", "1k"},
		{"portrait auto", "1080x1920", "auto", "9:16", "1k"},
		{"unrecognized", "bogus", "bogus", "", ""},
		// These three DISCRIMINATE log-space distance from a plain difference.
		// A linear comparison picks 3:4, 9:16 and 4:3 respectively; the oracle
		// returns what log distance gives, which is what makes the ratio choice
		// symmetric about 1:1 instead of biased toward the wide end.
		{"log-space 130x150", "130x150", "", "1:1", ""},
		{"log-space 130x200", "130x200", "", "3:4", ""},
		{"log-space 170x110", "170x110", "", "16:9", ""},
	} {
		server, captured := xaiStub(t, `{"data":[]}`, http.StatusOK)
		_, err := CallXaiImages(context.Background(), server.Client(),
			XaiImageRequest{Prompt: "p", Size: testCase.size, Quality: testCase.quality},
			BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0)
		if err != nil {
			t.Fatalf("%s: %v", testCase.name, err)
		}
		body := (*captured)[0].Body
		ratio, _ := body["aspect_ratio"].(string)
		resolution, _ := body["resolution"].(string)
		if ratio != testCase.wantRatio || resolution != testCase.wantResolution {
			t.Fatalf("%s = (%q, %q), oracle returns (%q, %q)",
				testCase.name, ratio, resolution, testCase.wantRatio, testCase.wantResolution)
		}
	}
}

// Oracle X7: an image URL switches the endpoint and carries the nested shape.
func TestCallXaiImagesEditEndpoint(t *testing.T) {
	server, captured := xaiStub(t, `{"data":[]}`, http.StatusOK)
	_, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p", ImageURL: "https://in/img.png"},
		BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	request := (*captured)[0]
	if request.Path != "/v1/images/edits" {
		t.Fatalf("path = %q, oracle uses /images/edits", request.Path)
	}
	image, _ := request.Body["image"].(map[string]any)
	if image["url"] != "https://in/img.png" || image["type"] != "image_url" {
		t.Fatalf("image = %#v", image)
	}
}

// Oracle X8: trailing slashes on the base URL do not produce a doubled path.
func TestCallXaiImagesTrimsTrailingSlashes(t *testing.T) {
	server, captured := xaiStub(t, `{"data":[]}`, http.StatusOK)
	_, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: server.URL + "/v1///", Token: "t"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if path := (*captured)[0].Path; path != "/v1/images/generations" {
		t.Fatalf("path = %q", path)
	}
}

// Oracle X9: the upstream status is PRESERVED rather than folded into a 502, so
// a caller can tell a rate limit from an auth failure.
func TestCallXaiImagesPreservesTheUpstreamStatus(t *testing.T) {
	server, _ := xaiStub(t, `nope`, http.StatusTooManyRequests)
	_, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0)
	var status *XaiStatusError
	if !errors.As(err, &status) {
		t.Fatalf("err = %v, want a status error", err)
	}
	if status.Status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, oracle preserves 429", status.Status)
	}
	if err.Error() != "xAI images API returned 429" {
		t.Fatalf("message = %q", err.Error())
	}
}

// The deadline has to cover the BODY READ, not just the headers, or a stalled
// upstream holds the request open past the budget.
func TestCallXaiImagesDeadlineCoversTheBodyRead(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			_, _ = io.WriteString(w, `{"data":`)
			flusher.Flush()
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()

	done := make(chan error, 1)
	go func() {
		_, err := CallXaiImages(context.Background(), server.Client(),
			XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"},
			200*time.Millisecond)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stalled body read returned success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call never returned; the deadline does not cover the body read")
	}
}

// A missing data array is an empty result rather than an error, matching the
// oracle's `json.data ?? []`.
func TestCallXaiImagesTreatsMissingDataAsEmpty(t *testing.T) {
	server, _ := xaiStub(t, `{}`, http.StatusOK)
	images, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0)
	if err != nil || len(images) != 0 {
		t.Fatalf("images = %#v, err = %v", images, err)
	}
}

// Degenerate sizes follow the oracle rather than being rejected. The oracle has
// no guard against them and the results are reachable: a zero height makes the
// ratio Infinity or NaN, whose comparisons are all false, so the FIRST
// candidate stays and the answer is 1:1.
func TestMapSizeToAspectRatioMatchesTheOracleOnDegenerateInput(t *testing.T) {
	for _, testCase := range []struct{ size, want string }{
		{"0x0", "1:1"},
		{"100x0", "1:1"},
		{"0x100", "1:1"},
		// Leading zeros parse as decimal on both sides.
		{"007x007", "1:1"},
		{"00100x00100", "1:1"},
		// Beyond int range: parseInt yields a finite float rather than failing,
		// so this lands on the widest ratio instead of being dropped.
		{"99999999999999999999x1", "16:9"},
		// Surrounding whitespace fails the pattern on both sides.
		{" 100x100", ""},
		{"100x100 ", ""},
	} {
		if got := mapSizeToAspectRatio(testCase.size); got != testCase.want {
			t.Fatalf("mapSizeToAspectRatio(%q) = %q, oracle returns %q", testCase.size, got, testCase.want)
		}
	}
}

// An explicit n of 0 is sent as 0. The oracle defaults with ?? rather than ||,
// so zero is a real request rather than an unset field.
func TestCallXaiImagesSendsAnExplicitZeroCount(t *testing.T) {
	server, captured := xaiStub(t, `{"data":[]}`, http.StatusOK)
	zero := 0
	_, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p", N: &zero}, BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := (*captured)[0].Body["n"]; got != float64(0) {
		t.Fatalf("n = %v, oracle sends an explicit 0", got)
	}

	// An absent count still defaults to 1.
	defaulted, capturedDefault := xaiStub(t, `{"data":[]}`, http.StatusOK)
	if _, err := CallXaiImages(context.Background(), defaulted.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: defaulted.URL + "/v1", Token: "t"}, 0); err != nil {
		t.Fatal(err)
	}
	if got := (*capturedDefault)[0].Body["n"]; got != float64(1) {
		t.Fatalf("default n = %v, oracle sends 1", got)
	}
}

// An explicitly empty model is sent as empty. The oracle defaults with ??
// rather than ||, and substituting the default would put a PAID model into a
// request that deliberately asked for none — the same guarantee the bridge
// config makes for bridgeModel.
func TestCallXaiImagesSendsAnExplicitEmptyModel(t *testing.T) {
	server, captured := xaiStub(t, `{"data":[]}`, http.StatusOK)
	empty := ""
	if _, err := CallXaiImages(context.Background(), server.Client(),
		XaiImageRequest{Prompt: "p", Model: &empty},
		BridgeAuth{BaseURL: server.URL + "/v1", Token: "t"}, 0); err != nil {
		t.Fatal(err)
	}
	if got := (*captured)[0].Body["model"]; got != "" {
		t.Fatalf("model = %v, oracle sends the empty string", got)
	}

	// An absent model still defaults.
	defaulted, capturedDefault := xaiStub(t, `{"data":[]}`, http.StatusOK)
	if _, err := CallXaiImages(context.Background(), defaulted.Client(),
		XaiImageRequest{Prompt: "p"}, BridgeAuth{BaseURL: defaulted.URL + "/v1", Token: "t"}, 0); err != nil {
		t.Fatal(err)
	}
	if got := (*capturedDefault)[0].Body["model"]; got != "grok-imagine-image-quality" {
		t.Fatalf("default model = %v", got)
	}
}
