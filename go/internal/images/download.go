package images

// Image download and materialization, ported from downloadImageToArtifact and
// materializeInlineImage in src/images/artifacts.ts.
//
// This is the consumer of the SSRF layer: it validates, resolves once, pins the
// peer, and only then reads bytes — with a hard cap, because a lying
// Content-Length or a compromised CDN must not be able to exhaust memory before
// the size check runs.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// PinnedDownload fetches a URL from an already-validated peer.
//
// Injected so tests never touch the network, and so the transport can be
// swapped without reopening the validation above it.
type PinnedDownload func(ctx context.Context, url string, pinned PinnedAddress) (int, io.ReadCloser, error)

// dataURLPattern matches the same shape the oracle accepts: a non-empty media
// type, an explicit base64 marker, and a non-empty payload.
var dataURLPattern = regexp.MustCompile(`^data:([^;]+);base64,(.+)$`)

// MaterializeInlineImage validates inline bytes and writes them to the
// artifacts directory.
//
// The extension comes from the DECODED bytes rather than a declared media
// type, so a provider cannot make the proxy write an executable by claiming it
// is a PNG.
func MaterializeInlineImage(dir, data string, budget *ImageBudget) (string, error) {
	decoded, err := DecodeValidatedImageBase64(data)
	if err != nil {
		return "", err
	}
	if err := ChargeImageBudget(budget, len(decoded)); err != nil {
		return "", err
	}
	ext, err := GuessExtFromMagic(decoded)
	if err != nil {
		return "", errors.New("inline image data is not a recognized image")
	}
	return writeArtifactUnique(dir, "img-", decoded, ext)
}

// DownloadImageToArtifact fetches one provider-returned image URL.
//
// A data URL never touches the network. Everything else goes through the full
// gate: HTTPS only, destination validated, DNS resolved once and pinned.
func DownloadImageToArtifact(
	ctx context.Context, dir, rawURL string, budget *ImageBudget, lookup IPLookup, download PinnedDownload,
) (string, error) {
	if strings.HasPrefix(rawURL, "data:") {
		match := dataURLPattern.FindStringSubmatch(rawURL)
		if match == nil {
			return "", errors.New("data URL is not a valid base64 image")
		}
		return MaterializeInlineImage(dir, match[2], budget)
	}

	if err := RequireHTTPSImageURL(rawURL); err != nil {
		return "", err
	}
	_, addresses, err := ResolvePublicAddresses(ctx, rawURL, lookup)
	if err != nil {
		return "", err
	}
	pinned, ok := PickPinnedAddress(addresses)
	if !ok {
		return "", errors.New("image URL has no usable address")
	}
	if download == nil {
		return "", errors.New("no pinned download transport configured")
	}

	status, body, err := download(ctx, rawURL, pinned)
	// Closed BEFORE the error is returned, not after. A transport can hand back
	// a live body alongside an error, and returning first would leak the socket
	// on exactly the provider-controlled failures this path exists to handle.
	if err != nil {
		if body != nil {
			_ = body.Close()
		}
		return "", err
	}
	if body != nil {
		defer func() { _ = body.Close() }()
	}
	// Anything other than 2xx is a failure, redirects included: following one
	// would re-target the connection past the address that was just validated.
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("image download failed: %d", status)
	}
	if body == nil {
		return "", errors.New("image download returned no body")
	}

	// One byte past the cap is read on purpose so an oversize body is
	// detectable rather than silently truncated into a valid-looking image.
	bytes, err := io.ReadAll(io.LimitReader(body, MaxDownloadBytes+1))
	if err != nil {
		return "", err
	}
	if len(bytes) > MaxDownloadBytes {
		return "", fmt.Errorf("image download exceeds %d byte cap", MaxDownloadBytes)
	}
	if len(bytes) == 0 {
		return "", errors.New("image download returned empty body")
	}
	ext, err := GuessExtFromMagic(bytes)
	if err != nil {
		return "", errors.New("image download did not contain a recognized image")
	}
	if err := ChargeImageBudget(budget, len(bytes)); err != nil {
		return "", err
	}
	return writeArtifactUnique(dir, "dl-", bytes, ext)
}

// writeArtifactUnique writes with exclusive create and retries on the
// astronomically unlikely name collision, so a fluke can never fail a write.
func writeArtifactUnique(dir, prefix string, data []byte, ext string) (string, error) {
	// 0o700: artifacts can contain user content and are served only through an
	// authenticated route, so the directory is not world-readable.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		name := prefix + timestampPrefix() + "-" + randomSuffix() + "." + ext
		path := filepath.Join(dir, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			lastErr = err
			continue
		}
		if _, err := file.Write(data); err != nil {
			_ = file.Close()
			_ = os.Remove(path)
			return "", err
		}
		if err := file.Close(); err != nil {
			return "", err
		}
		return path, nil
	}
	return "", fmt.Errorf("could not create a unique artifact file: %w", lastErr)
}

func timestampPrefix() string {
	now := time.Now()
	return fmt.Sprintf("%04d%02d%02d-%02d%02d%02d-%03d",
		now.Year(), now.Month(), now.Day(),
		now.Hour(), now.Minute(), now.Second(), now.Nanosecond()/1e6)
}

func randomSuffix() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		// Falling back to the clock keeps a write possible; uniqueness is then
		// carried by the exclusive-create retry above.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}
