package codex

import (
	"errors"
	"os"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// Reading a rollout off disk, ported from src/codex/history-provider.ts.
//
// This is the file half of the thread-field lookup; the parsing half lives in
// rollout_fields.go. A quarantine restore calls it on a rollout that has just
// been moved back, so every failure mode here has to end in "no fields" rather
// than an error the caller would have to invent a meaning for.

// MaxRolloutZstDecompressedBytes bounds an in-memory rollout decompression.
//
// Without it a small compressed file can expand until the process dies. The
// bound is INCLUSIVE: the oracle rejects only what exceeds it, so a rollout
// that decompresses to exactly this size is fine.
const MaxRolloutZstDecompressedBytes = 64 << 20

var errRolloutZstTooLarge = errors.New("rollout_zst_too_large")

// ReadThreadFieldsFromRollout loads a rollout and pulls its thread metadata.
//
// Every failure returns nil, matching the oracle's catch-all: a missing file,
// an unreadable one, a decompression that blows the bound, and a rollout with
// no session_meta are all "this rollout cannot tell us anything", and the
// caller decides whether that is fatal based on what the live schema demands.
func ReadThreadFieldsFromRollout(path string) *RolloutThreadFields {
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err != nil {
		return nil
	}

	var raw []byte
	var err error
	if strings.HasSuffix(path, ".zst") {
		raw, err = decompressRolloutZst(path)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil
	}
	return ParseThreadFieldsFromRolloutText(string(raw))
}

// decompressRolloutZst expands a compressed rollout under a hard output bound.
//
// The bound is applied as an OUTPUT limit, not a decoder memory limit. Capping
// decoder memory would also cap the window size, which rejects a perfectly
// small rollout that happens to have been compressed with a large window — a
// file the oracle reads without complaint.
func decompressRolloutZst(path string) ([]byte, error) {
	compressed, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoder, err := zstd.NewReader(nil, zstd.WithDecodeAllCapLimit(true))
	if err != nil {
		return nil, err
	}
	defer decoder.Close()

	// Capacity, not length: the cap limit measures against remaining capacity
	// and refuses to grow the destination past it.
	decoded, err := decoder.DecodeAll(compressed, make([]byte, 0, MaxRolloutZstDecompressedBytes))
	if err != nil {
		// Discard whatever partial output came back with the error.
		return nil, err
	}
	// Redundant against the cap above, but it is the shape the oracle states
	// and it keeps the contract visible if the decoder options ever change.
	if len(decoded) > MaxRolloutZstDecompressedBytes {
		return nil, errRolloutZstTooLarge
	}
	return decoded, nil
}
