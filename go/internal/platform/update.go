package platform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const MaxUpdateBytes int64 = 256 << 20

// UpdateDestination is an opaque identity snapshot for the executable being replaced.
type UpdateDestination struct {
	path string
	info os.FileInfo
}

var beforeUpdateReplace func()

func SnapshotUpdateDestination(path string) (UpdateDestination, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return UpdateDestination{}, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return UpdateDestination{}, fmt.Errorf("update destination must be an existing regular non-symlink file")
	}
	return UpdateDestination{path: filepath.Clean(absolute), info: info}, nil
}

// DownloadAndReplace downloads an HTTPS binary, verifies SHA-256, then atomically replaces destination.
func DownloadAndReplace(ctx context.Context, sourceURL, expectedSHA256 string, destination UpdateDestination) error {
	parsed, err := url.ParseRequestURI(sourceURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("update URL must be HTTPS")
	}
	expected, err := hex.DecodeString(strings.TrimSpace(expectedSHA256))
	if err != nil || len(expected) != sha256.Size {
		return fmt.Errorf("expected SHA-256 must be 64 hexadecimal characters")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("download update returned %s", response.Status)
	}
	if response.ContentLength > MaxUpdateBytes {
		return fmt.Errorf("update exceeds %d bytes", MaxUpdateBytes)
	}
	return replaceFromReader(io.LimitReader(response.Body, MaxUpdateBytes+1), expected, destination)
}

func replaceFromReader(reader io.Reader, expected []byte, destination UpdateDestination) error {
	if !destinationUnchanged(destination) {
		return fmt.Errorf("update destination changed before download")
	}
	dir := filepath.Dir(destination.path)
	temp, err := os.CreateTemp(dir, ".ocx-update-*")
	if err != nil {
		return fmt.Errorf("create update temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hash), reader)
	if copyErr != nil {
		temp.Close()
		return fmt.Errorf("write update: %w", copyErr)
	}
	if written > MaxUpdateBytes {
		temp.Close()
		return fmt.Errorf("update exceeds %d bytes", MaxUpdateBytes)
	}
	if !equalBytes(hash.Sum(nil), expected) {
		temp.Close()
		return fmt.Errorf("update SHA-256 mismatch")
	}
	if err := temp.Chmod(destination.info.Mode().Perm()); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if !destinationUnchanged(destination) {
		return fmt.Errorf("update destination changed during download")
	}
	if beforeUpdateReplace != nil {
		beforeUpdateReplace()
	}
	if !destinationUnchanged(destination) {
		return fmt.Errorf("update destination changed before replacement")
	}
	if err := atomicReplace(tempPath, destination.path); err != nil {
		return fmt.Errorf("atomically replace executable: %w", err)
	}
	return nil
}

func destinationUnchanged(snapshot UpdateDestination) bool {
	current, err := os.Lstat(snapshot.path)
	return err == nil && current.Mode()&os.ModeSymlink == 0 && current.Mode().IsRegular() &&
		os.SameFile(snapshot.info, current) && snapshot.info.Size() == current.Size() &&
		snapshot.info.ModTime() == current.ModTime() && snapshot.info.Mode() == current.Mode()
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for index := range left {
		different |= left[index] ^ right[index]
	}
	return different == 0
}
