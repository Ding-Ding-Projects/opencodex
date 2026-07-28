package images

// Artifact validation and identity, ported from src/images/artifacts.ts.
//
// This file is a security boundary. Artifact ids reach it from model output and
// from HTTP paths, and inline image bytes reach it from an upstream provider,
// so every function here refuses rather than guesses.

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	// MaxDecodedBytesPerImage caps one materialized image.
	MaxDecodedBytesPerImage = 50 * 1024 * 1024
	// MaxDecodedBytesPerResponse caps every image in one response together, so
	// a provider cannot exhaust memory by returning many images just under the
	// per-image limit.
	MaxDecodedBytesPerResponse = 100 * 1024 * 1024
	// MaxDownloadBytes is the hard cap for a remote image download.
	MaxDownloadBytes = 50 * 1024 * 1024
	// DefaultArtifactKeepCount bounds the artifacts directory.
	DefaultArtifactKeepCount = 200
	// ArtifactHTTPPrefix is the opaque, API-auth-gated artifact route.
	ArtifactHTTPPrefix = "/v1/opencodex/artifacts"
)

// MaxEncodedBytesPerImage bounds the RAW base64 before it is decoded, so an
// oversized payload is refused before normalization copies it. Base64 expands
// three bytes into four characters.
var MaxEncodedBytesPerImage = (MaxDecodedBytesPerImage*4 + 2) / 3

// artifactIDPattern is the only shape an artifact id may take.
//
// The leading character class excludes a dot, which is what stops "..png" and
// any other dot-led name from being addressable.
var artifactIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?i:png|jpe?g|webp|gif)$`)

// base64Pattern is a STRICT alphabet check, because Go and JavaScript base64
// decoders both tolerate surprises: malformed payloads would otherwise decode
// to garbage bytes that then fail a confusing magic-byte check instead.
var base64Pattern = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)

// jsWhitespacePattern matches what JavaScript's \s matches, which is WIDER
// than Go's.
//
// RE2's \s is ASCII-only, so a base64 payload carrying a non-breaking space or
// a BOM would keep that character, fail the strict alphabet check, and be
// rejected as invalid — while the oracle strips it and decodes the image
// fine. Measured against the oracle with NBSP, figure space, BOM, line
// separator, ideographic space and vertical tab: all six decode.
var jsWhitespacePattern = regexp.MustCompile(
	"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")

// ImageBudget tracks decoded bytes across one response.
type ImageBudget struct {
	Spent int
}

// ChargeImageBudget reserves bytes, refusing once the per-response cap is hit.
func ChargeImageBudget(budget *ImageBudget, bytes int) error {
	if budget == nil {
		return nil
	}
	if budget.Spent+bytes > MaxDecodedBytesPerResponse {
		return fmt.Errorf("image response exceeds %d byte per-response cap", MaxDecodedBytesPerResponse)
	}
	budget.Spent += bytes
	return nil
}

// SniffImageExtension identifies a format from its magic bytes.
//
// The PNG check requires the FULL eight-byte signature: a truncated prefix is
// rejected rather than trusted, since a partial match is exactly what a crafted
// payload would produce.
func SniffImageExtension(bytes []byte) string {
	if len(bytes) == 0 {
		return ""
	}
	head := bytes
	if len(head) > 12 {
		head = head[:12]
	}
	signature := string(head)
	switch {
	case strings.HasPrefix(signature, "\x89PNG\r\n\x1a\n"):
		return "png"
	case strings.HasPrefix(signature, "\xff\xd8\xff"):
		return "jpg"
	case strings.HasPrefix(signature, "RIFF") && len(signature) >= 12 && signature[8:12] == "WEBP":
		return "webp"
	case strings.HasPrefix(signature, "GIF8"):
		return "gif"
	}
	return ""
}

// ErrUnrecognizedImage is returned when magic bytes match no supported format.
var ErrUnrecognizedImage = errors.New(
	"unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF")

// GuessExtFromMagic is SniffImageExtension with a refusal instead of an empty
// result, so a caller cannot accidentally write an unidentified file.
func GuessExtFromMagic(bytes []byte) (string, error) {
	if ext := SniffImageExtension(bytes); ext != "" {
		return ext, nil
	}
	return "", ErrUnrecognizedImage
}

// DecodeValidatedImageBase64 decodes inline image bytes, checking the alphabet,
// the size, and the magic bytes before the caller can write anything.
//
// The size is computed from the ENCODED length first, so an oversized payload
// is refused before it is expanded in memory.
func DecodeValidatedImageBase64(data string) ([]byte, error) {
	normalized := jsWhitespacePattern.ReplaceAllString(data, "")
	if !base64Pattern.MatchString(normalized) || len(normalized)%4 != 0 {
		return nil, errors.New("inline image data is not valid base64")
	}
	if len(normalized) > MaxEncodedBytesPerImage {
		return nil, fmt.Errorf("inline image exceeds %d byte per-image cap", MaxDecodedBytesPerImage)
	}
	padding := 0
	switch {
	case strings.HasSuffix(normalized, "=="):
		padding = 2
	case strings.HasSuffix(normalized, "="):
		padding = 1
	}
	decodedBytes := len(normalized)/4*3 - padding
	if decodedBytes == 0 {
		return nil, errors.New("inline image data is empty after base64 decode")
	}
	if decodedBytes > MaxDecodedBytesPerImage {
		return nil, fmt.Errorf("inline image exceeds %d byte per-image cap", MaxDecodedBytesPerImage)
	}
	decoded, err := base64.StdEncoding.DecodeString(normalized)
	if err != nil {
		return nil, errors.New("inline image data is not valid base64")
	}
	if _, err := GuessExtFromMagic(decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

// ArtifactHTTPURL builds the model-visible URL for a materialized artifact.
//
// Only the base name is used, so a host filesystem path can never reach
// model-visible content, and the result is refused outright if that base name
// is not a valid opaque id.
func ArtifactHTTPURL(filePath string) (string, error) {
	name := filepath.Base(filePath)
	if !artifactIDPattern.MatchString(name) {
		return "", errors.New("artifact filename is not a valid opaque id")
	}
	return ArtifactHTTPPrefix + "/" + name, nil
}

// ResolveArtifactPath maps an opaque id to a real file under dir.
//
// Traversal is refused twice over: the id pattern excludes separators and
// dot-led names, and the resolved path is then required to stay inside dir. The
// second check is what survives a future loosening of the first.
func ResolveArtifactPath(dir, id string) string {
	if !artifactIDPattern.MatchString(id) {
		return ""
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	candidate := filepath.Join(root, id)
	if candidate != root && !strings.HasPrefix(candidate, root+string(filepath.Separator)) {
		return ""
	}
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return candidate
}

// ArtifactContentType maps an artifact's extension to its media type, falling
// back to a generic type rather than guessing.
func ArtifactContentType(path string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(path), ".")) {
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	}
	return "application/octet-stream"
}

// PruneOldArtifacts deletes the oldest files until at most maxFiles remain.
//
// A non-positive maxFiles DISABLES pruning rather than deleting everything,
// which is the difference between an unset config and a destructive one. Every
// error is swallowed: a prune failure must never break an image write.
func PruneOldArtifacts(dir string, maxFiles int) {
	if maxFiles <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	if len(entries) <= maxFiles {
		return
	}
	type aged struct {
		name    string
		modTime int64
	}
	files := make([]aged, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			// The oracle abandons the whole prune when a stat fails, rather
			// than deleting from an incomplete picture.
			return
		}
		files = append(files, aged{name: entry.Name(), modTime: info.ModTime().UnixNano()})
	}
	sort.SliceStable(files, func(a, b int) bool { return files[a].modTime < files[b].modTime })
	for _, file := range files[:len(files)-maxFiles] {
		_ = os.Remove(filepath.Join(dir, file.name))
	}
}
