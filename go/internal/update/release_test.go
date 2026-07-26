package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestReleaseArtifactNamesCoverDistributionMatrix(t *testing.T) {
	tests := map[string]string{
		"darwin/amd64":  "ocx_2.8.0_darwin_amd64",
		"darwin/arm64":  "ocx_2.8.0_darwin_arm64",
		"linux/amd64":   "ocx_2.8.0_linux_amd64",
		"linux/arm64":   "ocx_2.8.0_linux_arm64",
		"windows/amd64": "ocx_2.8.0_windows_amd64.exe",
		"windows/arm64": "ocx_2.8.0_windows_arm64.exe",
	}
	for target, want := range tests {
		parts := strings.Split(target, "/")
		if got := ReleaseArtifactName("2.8.0", parts[0], parts[1]); got != want {
			t.Errorf("%s artifact=%q want=%q", target, got, want)
		}
	}
	if got := ReleaseChecksumName("2.8.0"); got != "ocx_2.8.0_checksums.txt" {
		t.Fatalf("checksum artifact=%q", got)
	}
}

func TestGitHubReleaseResolverSelectsChannelAndVerifiedArtifact(t *testing.T) {
	const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		version := "2.8.0"
		if request.URL.Path == "/repos/lidge-jun/opencodex/releases" {
			version = "2.9.0-preview.20260726"
			writeReleaseJSON(t, writer, []releasePayload{
				newReleasePayload(server.URL, "v2.8.0", false, false),
				newReleasePayload(server.URL, "v"+version, true, false),
			})
			return
		}
		if request.URL.Path == "/repos/lidge-jun/opencodex/releases/latest" {
			writeReleaseJSON(t, writer, newReleasePayload(server.URL, "v"+version, false, false))
			return
		}
		if strings.HasSuffix(request.URL.Path, "_checksums.txt") {
			if strings.Contains(request.URL.Path, "preview") {
				version = "2.9.0-preview.20260726"
			}
			name := ReleaseArtifactName(version, "darwin", "arm64")
			_, _ = fmt.Fprintf(writer, "%s  %s\n", digest, name)
			return
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	host := mustURL(t, server.URL).Host
	resolver := GitHubReleaseResolver{Client: server.Client(), APIBase: server.URL, GOOS: "darwin", GOARCH: "arm64", AllowedAssetHosts: []string{host}}

	latest, err := resolver.Resolve(context.Background(), ChannelLatest)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Version != "2.8.0" || latest.Name != "ocx_2.8.0_darwin_arm64" || latest.SHA256 != digest {
		t.Fatalf("latest=%#v", latest)
	}
	preview, err := resolver.Resolve(context.Background(), ChannelPreview)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Version != "2.9.0-preview.20260726" || preview.Name != "ocx_2.9.0-preview.20260726_darwin_arm64" || preview.SHA256 != digest {
		t.Fatalf("preview=%#v", preview)
	}
}

func TestGitHubReleaseResolverRejectsUntrustedAssetHost(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		payload := newReleasePayload("https://downloads.example.test", "v2.8.0", false, false)
		writeReleaseJSON(t, writer, payload)
	}))
	defer server.Close()
	resolver := GitHubReleaseResolver{Client: server.Client(), APIBase: server.URL, GOOS: "linux", GOARCH: "amd64", AllowedAssetHosts: []string{"github.com"}}
	if _, err := resolver.Resolve(context.Background(), ChannelLatest); err == nil || !strings.Contains(err.Error(), "trusted GitHub release host") {
		t.Fatalf("untrusted asset error=%v", err)
	}
}

func TestParseReleaseChecksumRejectsMissingDuplicateAndMalformedEntries(t *testing.T) {
	name := "ocx_2.8.0_linux_amd64"
	digest := strings.Repeat("a", 64)
	if got, err := ParseReleaseChecksum(digest+"  "+name+"\n", name); err != nil || got != digest {
		t.Fatalf("valid checksum=%q err=%v", got, err)
	}
	for _, manifest := range []string{
		strings.Repeat("b", 64) + "  other\n",
		digest + "  " + name + "\n" + digest + "  " + name + "\n",
		"not-a-digest  " + name + "\n",
	} {
		if _, err := ParseReleaseChecksum(manifest, name); err == nil {
			t.Fatalf("manifest accepted: %q", manifest)
		}
	}
}

type releasePayload struct {
	TagName    string         `json:"tag_name"`
	Prerelease bool           `json:"prerelease"`
	Draft      bool           `json:"draft"`
	Assets     []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

func newReleasePayload(baseURL, tag string, prerelease, draft bool) releasePayload {
	version := strings.TrimPrefix(tag, "v")
	names := []string{ReleaseArtifactName(version, "darwin", "arm64"), ReleaseArtifactName(version, "linux", "amd64"), ReleaseChecksumName(version)}
	assets := make([]releaseAsset, 0, len(names))
	for _, name := range names {
		assets = append(assets, releaseAsset{Name: name, URL: baseURL + "/lidge-jun/opencodex/releases/download/" + tag + "/" + name})
	}
	return releasePayload{TagName: tag, Prerelease: prerelease, Draft: draft, Assets: assets}
}

func writeReleaseJSON(t *testing.T, writer http.ResponseWriter, value any) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
