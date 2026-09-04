package update

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"
)

const (
	GitHubAPIBase          = "https://api.github.com"
	GitHubReleaseRepo      = "lidge-jun/opencodex"
	maxReleaseMetadataSize = 2 << 20
	maxChecksumManifest    = 1 << 20
)

type ReleaseArtifact struct {
	Channel Channel
	Tag     string
	Version string
	Name    string
	URL     string
	SHA256  string
}

type GitHubReleaseResolver struct {
	Client            *http.Client
	APIBase           string
	GOOS              string
	GOARCH            string
	AllowedAssetHosts []string
}

type githubRelease struct {
	TagName    string `json:"tag_name"`
	Prerelease bool   `json:"prerelease"`
	Draft      bool   `json:"draft"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func ReleaseArtifactName(version, goos, goarch string) string {
	name := fmt.Sprintf("ocx_%s_%s_%s", version, goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

func ReleaseChecksumName(version string) string {
	return fmt.Sprintf("ocx_%s_checksums.txt", version)
}

func NewGitHubReleaseResolver() GitHubReleaseResolver {
	return GitHubReleaseResolver{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
}

func (resolver GitHubReleaseResolver) Resolve(ctx context.Context, channel Channel) (ReleaseArtifact, error) {
	if err := ValidateChannel(channel); err != nil {
		return ReleaseArtifact{}, err
	}
	base := strings.TrimRight(strings.TrimSpace(resolver.APIBase), "/")
	if base == "" {
		base = GitHubAPIBase
	}
	if err := requireHTTPSURL(base); err != nil {
		return ReleaseArtifact{}, fmt.Errorf("GitHub API base: %w", err)
	}
	release, err := resolver.resolveRelease(ctx, base, channel)
	if err != nil {
		return ReleaseArtifact{}, err
	}
	version := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	if !validReleaseVersion(version, channel) {
		return ReleaseArtifact{}, fmt.Errorf("release tag %q does not match channel %q", release.TagName, channel)
	}
	goos, goarch := resolver.GOOS, resolver.GOARCH
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	binaryName := ReleaseArtifactName(version, goos, goarch)
	checksumName := ReleaseChecksumName(version)
	binaryURL, checksumURL, err := resolver.findReleaseAssets(release, binaryName, checksumName)
	if err != nil {
		return ReleaseArtifact{}, err
	}
	manifest, err := resolver.fetch(ctx, checksumURL, maxChecksumManifest)
	if err != nil {
		return ReleaseArtifact{}, fmt.Errorf("download release checksum manifest: %w", err)
	}
	digest, err := ParseReleaseChecksum(string(manifest), binaryName)
	if err != nil {
		return ReleaseArtifact{}, err
	}
	return ReleaseArtifact{Channel: channel, Tag: release.TagName, Version: version, Name: binaryName, URL: binaryURL, SHA256: digest}, nil
}

func (resolver GitHubReleaseResolver) resolveRelease(ctx context.Context, base string, channel Channel) (githubRelease, error) {
	if channel == ChannelLatest {
		data, err := resolver.fetch(ctx, base+"/repos/"+GitHubReleaseRepo+"/releases/latest", maxReleaseMetadataSize)
		if err != nil {
			return githubRelease{}, fmt.Errorf("resolve latest GitHub release: %w", err)
		}
		var release githubRelease
		if json.Unmarshal(data, &release) != nil || release.Draft || release.Prerelease {
			return githubRelease{}, errors.New("latest GitHub release metadata is invalid")
		}
		return release, nil
	}
	data, err := resolver.fetch(ctx, base+"/repos/"+GitHubReleaseRepo+"/releases?per_page=30", maxReleaseMetadataSize)
	if err != nil {
		return githubRelease{}, fmt.Errorf("resolve preview GitHub release: %w", err)
	}
	var releases []githubRelease
	if json.Unmarshal(data, &releases) != nil {
		return githubRelease{}, errors.New("preview GitHub release metadata is invalid")
	}
	for _, release := range releases {
		version := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
		if !release.Draft && release.Prerelease && validReleaseVersion(version, ChannelPreview) {
			return release, nil
		}
	}
	return githubRelease{}, errors.New("no preview GitHub release is available")
}

func (resolver GitHubReleaseResolver) findReleaseAssets(release githubRelease, binaryName, checksumName string) (string, string, error) {
	var binaryURL, checksumURL string
	for _, asset := range release.Assets {
		switch asset.Name {
		case binaryName:
			if binaryURL != "" {
				return "", "", fmt.Errorf("release contains duplicate artifact %q", binaryName)
			}
			binaryURL = asset.URL
		case checksumName:
			if checksumURL != "" {
				return "", "", fmt.Errorf("release contains duplicate artifact %q", checksumName)
			}
			checksumURL = asset.URL
		}
	}
	if binaryURL == "" || checksumURL == "" {
		return "", "", fmt.Errorf("release is missing %q or %q", binaryName, checksumName)
	}
	for _, raw := range []string{binaryURL, checksumURL} {
		if err := resolver.validateAssetURL(raw); err != nil {
			return "", "", err
		}
	}
	return binaryURL, checksumURL, nil
}

func (resolver GitHubReleaseResolver) validateAssetURL(raw string) error {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("release asset URL must be HTTPS without user information")
	}
	allowed := resolver.AllowedAssetHosts
	if len(allowed) == 0 {
		allowed = []string{"github.com"}
	}
	trusted := false
	for _, host := range allowed {
		if strings.EqualFold(parsed.Host, strings.TrimSpace(host)) {
			trusted = true
			break
		}
	}
	if !trusted || !strings.HasPrefix(parsed.Path, "/"+GitHubReleaseRepo+"/releases/download/") {
		return fmt.Errorf("release asset URL is not on a trusted GitHub release host")
	}
	return nil
}

func (resolver GitHubReleaseResolver) fetch(ctx context.Context, raw string, limit int64) ([]byte, error) {
	if err := requireHTTPSURL(raw); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "opencodex-native-updater")
	client := resolver.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub returned %s", response.Status)
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("GitHub response exceeds %d bytes", limit)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("GitHub response exceeds %d bytes", limit)
	}
	return data, nil
}

func ParseReleaseChecksum(manifest, artifactName string) (string, error) {
	found := ""
	for _, line := range strings.Split(manifest, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return "", errors.New("release checksum manifest has an invalid line")
		}
		digest, name := strings.ToLower(fields[0]), strings.TrimPrefix(fields[1], "*")
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != 32 {
			return "", errors.New("release checksum manifest has an invalid SHA-256")
		}
		if name != artifactName {
			continue
		}
		if found != "" {
			return "", fmt.Errorf("release checksum manifest contains duplicate entry for %q", artifactName)
		}
		found = digest
	}
	if found == "" {
		return "", fmt.Errorf("release checksum manifest has no entry for %q", artifactName)
	}
	return found, nil
}

func validReleaseVersion(version string, channel Channel) bool {
	if channel == ChannelLatest {
		_, ok := parseStable(version)
		return ok
	}
	_, ok := parsePreview(version)
	return ok
}

func requireHTTPSURL(raw string) error {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("URL must be HTTPS without user information")
	}
	return nil
}
