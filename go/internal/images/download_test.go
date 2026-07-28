package images

// Differential against downloadImageToArtifact and materializeInlineImage in
// src/images/artifacts.ts. Every expectation was captured by RUNNING the
// oracle.

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
)

func publicLookup(context.Context, string) ([]net.IP, error) {
	return []net.IP{net.ParseIP("8.8.8.8")}, nil
}

func stubDownload(status int, body []byte) PinnedDownload {
	return func(context.Context, string, PinnedAddress) (int, io.ReadCloser, error) {
		return status, io.NopCloser(strings.NewReader(string(body))), nil
	}
}

func refuseDownload(t *testing.T) PinnedDownload {
	t.Helper()
	return func(context.Context, string, PinnedAddress) (int, io.ReadCloser, error) {
		t.Fatal("a refused URL still reached the transport")
		return 0, nil, nil
	}
}

// Oracle: a data URL never touches the network, and the shape is strict — a
// missing media type, a missing base64 marker, and a bare "data:" are all
// refused with the same message.
func TestDownloadImageToArtifactHandlesDataURLs(t *testing.T) {
	dir := t.TempDir()
	encoded := base64.StdEncoding.EncodeToString(pngBytes)
	path, err := DownloadImageToArtifact(context.Background(), dir,
		"data:image/png;base64,"+encoded, nil, nil, refuseDownload(t))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(path), "img-") || !strings.HasSuffix(path, ".png") {
		t.Fatalf("path = %q", path)
	}

	for _, raw := range []string{
		"data:;base64," + encoded,
		"data:image/png,abc",
		"data:",
	} {
		_, err := DownloadImageToArtifact(context.Background(), dir, raw, nil, nil, refuseDownload(t))
		if err == nil || err.Error() != "data URL is not a valid base64 image" {
			t.Fatalf("%q: err = %v", raw, err)
		}
	}
}

// Oracle: the scheme and destination gates run BEFORE the transport, so a
// refused URL is never fetched at all.
func TestDownloadImageToArtifactRefusesBeforeFetching(t *testing.T) {
	dir := t.TempDir()
	for _, testCase := range []struct{ url, want string }{
		{"http://8.8.8.8/x.png", "image URL must use HTTPS, got http:"},
		{"ftp://8.8.8.8/x.png", "image URL must use HTTPS, got ftp:"},
		{"https://127.0.0.1/x.png", "image URL targets loopback address"},
	} {
		_, err := DownloadImageToArtifact(context.Background(), dir, testCase.url, nil, nil, refuseDownload(t))
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%s: err = %v, oracle returns %q", testCase.url, err, testCase.want)
		}
	}
}

// Oracle: 2xx only. A redirect is a FAILURE rather than something to follow,
// because following it would re-target the connection past the address that was
// just validated and pinned.
func TestDownloadImageToArtifactRequiresA2xx(t *testing.T) {
	dir := t.TempDir()
	for _, status := range []int{404, 302, 500, 199} {
		_, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png",
			nil, publicLookup, stubDownload(status, pngBytes))
		if err == nil || !strings.Contains(err.Error(), "image download failed:") {
			t.Fatalf("status %d: err = %v", status, err)
		}
	}
}

// Oracle: an empty body and a non-image body get different refusals, since one
// is a broken upstream and the other is a payload worth not writing.
func TestDownloadImageToArtifactValidatesTheBody(t *testing.T) {
	dir := t.TempDir()
	_, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png",
		nil, publicLookup, stubDownload(200, nil))
	if err == nil || err.Error() != "image download returned empty body" {
		t.Fatalf("empty: err = %v", err)
	}
	_, err = DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png",
		nil, publicLookup, stubDownload(200, []byte{1, 2, 3, 4}))
	if err == nil || err.Error() != "image download did not contain a recognized image" {
		t.Fatalf("non-image: err = %v", err)
	}
}

// A successful download is written with the dl- prefix and the extension
// sniffed from the BYTES, not from anything the response claimed.
func TestDownloadImageToArtifactWritesTheFile(t *testing.T) {
	dir := t.TempDir()
	path, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png",
		nil, publicLookup, stubDownload(200, pngBytes))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(path), "dl-") || !strings.HasSuffix(path, ".png") {
		t.Fatalf("path = %q", path)
	}
	written, err := os.ReadFile(path)
	if err != nil || string(written) != string(pngBytes) {
		t.Fatalf("contents differ: %v", err)
	}
	// The file is owner-only: artifacts hold user content and are served only
	// through an authenticated route.
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	// The name has to be a valid opaque id, or it could never be served back.
	if _, err := ArtifactHTTPURL(path); err != nil {
		t.Fatalf("written name is not a valid artifact id: %v", err)
	}
}

// The byte cap is enforced on the STREAM, so a lying Content-Length or a
// compromised CDN cannot exhaust memory before the size check runs.
func TestDownloadImageToArtifactEnforcesTheByteCap(t *testing.T) {
	dir := t.TempDir()
	// The stream is UNBOUNDED on purpose. Bounding it in the test would let a
	// missing cap pass by exhausting the reader instead of the process, which
	// is exactly the failure this guards against.
	counted := &countingReader{}
	oversize := func(context.Context, string, PinnedAddress) (int, io.ReadCloser, error) {
		return 200, io.NopCloser(counted), nil
	}
	_, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png", nil, publicLookup, oversize)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("err = %v, want a cap refusal", err)
	}
	// Reading much past the cap means the limit is not being applied.
	if counted.total > MaxDownloadBytes+1024 {
		t.Fatalf("read %d bytes, cap is %d", counted.total, MaxDownloadBytes)
	}
}

type countingReader struct{ total int }

func (r *countingReader) Read(p []byte) (int, error) {
	for index := range p {
		p[index] = 'A'
	}
	r.total += len(p)
	if r.total > 4*MaxDownloadBytes {
		return 0, errors.New("reader ran away; the byte cap is not being enforced")
	}
	return len(p), nil
}

// A transport error propagates rather than being swallowed into a generic
// failure, so a caller can tell a network fault from a rejected image.
func TestDownloadImageToArtifactPropagatesTransportErrors(t *testing.T) {
	dir := t.TempDir()
	failing := func(context.Context, string, PinnedAddress) (int, io.ReadCloser, error) {
		return 0, nil, errors.New("dial refused")
	}
	_, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png", nil, publicLookup, failing)
	if err == nil || err.Error() != "dial refused" {
		t.Fatalf("err = %v", err)
	}
}

// The per-response budget spans images, so several downloads just under the
// per-image cap still cannot exhaust memory together.
func TestDownloadImageToArtifactChargesTheBudget(t *testing.T) {
	dir := t.TempDir()
	budget := &ImageBudget{Spent: MaxDecodedBytesPerResponse - 1}
	_, err := DownloadImageToArtifact(context.Background(), dir, "https://8.8.8.8/x.png",
		budget, publicLookup, stubDownload(200, pngBytes))
	if err == nil || !strings.Contains(err.Error(), "per-response cap") {
		t.Fatalf("err = %v, want a budget refusal", err)
	}
}
