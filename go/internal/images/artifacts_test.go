package images

// Differential against src/images/artifacts.ts. Every expectation was captured
// by RUNNING the oracle.

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var pngBytes = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3, 4}

// Oracle A1-A9: format sniffing. The PNG case requires the FULL eight-byte
// signature, so a truncated prefix is refused rather than trusted.
func TestSniffImageExtensionMatchesTheOracle(t *testing.T) {
	webp := append(append([]byte("RIFF"), 0, 0, 0, 0), []byte("WEBP")...)
	wrongRIFF := append(append([]byte("RIFF"), 0, 0, 0, 0), []byte("XXXX")...)
	for _, testCase := range []struct {
		name  string
		bytes []byte
		want  string
	}{
		{"png", pngBytes, "png"},
		{"truncated png", []byte{0x89, 'P', 'N', 'G'}, ""},
		{"jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}, "jpg"},
		{"webp", webp, "webp"},
		{"riff but not webp", wrongRIFF, ""},
		{"gif89a", []byte("GIF89a"), "gif"},
		{"gif8 alone", []byte("GIF8"), "gif"},
		{"empty", nil, ""},
		{"junk", []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, ""},
	} {
		if got := SniffImageExtension(testCase.bytes); got != testCase.want {
			t.Fatalf("%s = %q, oracle returns %q", testCase.name, got, testCase.want)
		}
	}
}

// Oracle A10: the refusal message is part of the contract, since it reaches a
// tool result the model reads.
func TestGuessExtFromMagicRefusesUnknownFormats(t *testing.T) {
	if _, err := GuessExtFromMagic([]byte{1, 2, 3}); err == nil ||
		err.Error() != "unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF" {
		t.Fatalf("err = %v", err)
	}
	if ext, err := GuessExtFromMagic(pngBytes); err != nil || ext != "png" {
		t.Fatalf("png = (%q, %v)", ext, err)
	}
}

// Oracle A11-A13: base64 validation, including that whitespace is stripped
// first and that each refusal keeps its own message.
func TestDecodeValidatedImageBase64MatchesTheOracle(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(pngBytes)
	decoded, err := DecodeValidatedImageBase64(encoded)
	if err != nil || len(decoded) != 12 {
		t.Fatalf("decode = (%d, %v)", len(decoded), err)
	}
	// Embedded whitespace is normalized away before validation.
	spaced := encoded[:4] + "\n  " + encoded[4:]
	if decoded, err := DecodeValidatedImageBase64(spaced); err != nil || len(decoded) != 12 {
		t.Fatalf("spaced decode = (%d, %v)", len(decoded), err)
	}

	for _, testCase := range []struct{ name, input, want string }{
		{"invalid alphabet", "!!!!", "inline image data is not valid base64"},
		{"bad length", "QUJDQ", "inline image data is not valid base64"},
		{"empty", "", "inline image data is empty after base64 decode"},
		{
			"valid base64 but not an image",
			base64.StdEncoding.EncodeToString([]byte("hello world!")),
			"unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF",
		},
	} {
		_, err := DecodeValidatedImageBase64(testCase.input)
		if err == nil || err.Error() != testCase.want {
			t.Fatalf("%s: err = %v, oracle returns %q", testCase.name, err, testCase.want)
		}
	}
}

// Oracle A14: only the BASE NAME is used, so a path can never reach
// model-visible content, and a dot-led name is refused entirely.
func TestArtifactHTTPURLMatchesTheOracle(t *testing.T) {
	for _, testCase := range []struct{ input, want string }{
		{"a.png", "/v1/opencodex/artifacts/a.png"},
		{"A1.jpeg", "/v1/opencodex/artifacts/A1.jpeg"},
		{"x_y-z.webp", "/v1/opencodex/artifacts/x_y-z.webp"},
		{"q.gif", "/v1/opencodex/artifacts/q.gif"},
		// Traversal collapses to the base name rather than being rejected: the
		// id itself is still valid, and the caller never sees the directory.
		{"../x.png", "/v1/opencodex/artifacts/x.png"},
		{"a/b.png", "/v1/opencodex/artifacts/b.png"},
		// Uppercase extensions are accepted.
		{"a.PNG", "/v1/opencodex/artifacts/a.PNG"},
		// A dot-led name is refused, which is what stops "..png".
		{"..png", ""},
		{".png", ""},
		{"a.txt", ""},
	} {
		got, err := ArtifactHTTPURL("/tmp/" + testCase.input)
		if testCase.want == "" {
			if err == nil {
				t.Fatalf("%q returned %q, oracle refuses it", testCase.input, got)
			}
			continue
		}
		if err != nil || got != testCase.want {
			t.Fatalf("%q = (%q, %v), oracle returns %q", testCase.input, got, err, testCase.want)
		}
	}

	// 200 characters before the extension is the boundary; 201 is still
	// accepted by the pattern because the first character is counted
	// separately. Both were measured against the oracle.
	for _, length := range []int{200, 201} {
		name := strings.Repeat("x", length) + ".png"
		if _, err := ArtifactHTTPURL("/tmp/" + name); err != nil {
			t.Fatalf("%d-character name was refused: %v", length, err)
		}
	}
}

// Oracle A18: traversal is refused, and a valid id still requires the file to
// exist and to be a regular file.
func TestResolveArtifactPathRefusesTraversal(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "a.png")
	if err := os.WriteFile(real, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ResolveArtifactPath(dir, "a.png"); got != real {
		t.Fatalf("valid id = %q, want %q", got, real)
	}
	for _, id := range []string{"../etc/passwd", "a/b.png", "..png", ".png", "missing.png", "a.txt"} {
		if got := ResolveArtifactPath(dir, id); got != "" {
			t.Fatalf("%q resolved to %q, want a refusal", id, got)
		}
	}
	// A directory named like an artifact is not a file and must be refused.
	if err := os.Mkdir(filepath.Join(dir, "d.png"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := ResolveArtifactPath(dir, "d.png"); got != "" {
		t.Fatalf("a directory resolved to %q", got)
	}
}

// Oracle A16-A17: the per-response budget refuses rather than truncating, so a
// provider cannot exhaust memory with many images just under the per-image cap.
func TestChargeImageBudgetMatchesTheOracle(t *testing.T) {
	budget := &ImageBudget{}
	if err := ChargeImageBudget(budget, 100); err != nil || budget.Spent != 100 {
		t.Fatalf("charge = (%d, %v)", budget.Spent, err)
	}
	err := ChargeImageBudget(budget, MaxDecodedBytesPerResponse)
	if err == nil || err.Error() != "image response exceeds 104857600 byte per-response cap" {
		t.Fatalf("overflow err = %v", err)
	}
	// A refused charge does not consume budget.
	if budget.Spent != 100 {
		t.Fatalf("spent = %d after a refusal, want 100", budget.Spent)
	}
	// A nil budget is a no-op rather than a crash.
	if err := ChargeImageBudget(nil, 1); err != nil {
		t.Fatalf("nil budget: %v", err)
	}
}

// A non-positive keep count DISABLES pruning rather than emptying the
// directory, which is the difference between an unset config and a destructive
// one.
func TestPruneOldArtifactsKeepsTheNewest(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	names := []string{"old.png", "mid.png", "new.png"}
	for index, name := range names {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pngBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := base.Add(time.Duration(index) * time.Minute)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}

	PruneOldArtifacts(dir, 0)
	if entries, _ := os.ReadDir(dir); len(entries) != 3 {
		t.Fatalf("a zero keep count deleted %d files", 3-len(entries))
	}
	PruneOldArtifacts(dir, -1)
	if entries, _ := os.ReadDir(dir); len(entries) != 3 {
		t.Fatal("a negative keep count deleted files")
	}

	PruneOldArtifacts(dir, 2)
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("prune left %d files, want 2", len(entries))
	}
	for _, entry := range entries {
		if entry.Name() == "old.png" {
			t.Fatal("prune deleted a newer file and kept the oldest")
		}
	}

	// A missing directory is survivable, not fatal.
	PruneOldArtifacts(filepath.Join(dir, "absent"), 1)
}

// A symlink inside the artifacts directory resolves to its target on BOTH
// sides: the oracle's existsSync/statSync follow links and so does os.Stat.
// Pinned as a known, matched behaviour rather than left to be discovered as a
// surprise, since the id pattern is what actually bounds what can be requested.
func TestResolveArtifactPathFollowsSymlinksLikeTheOracle(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "outside-artifact.png")
	if err := os.WriteFile(outside, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(outside) })
	link := filepath.Join(dir, "link.png")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// The returned path stays INSIDE the artifacts directory even though the
	// bytes live elsewhere, so nothing outside is ever named to a caller.
	if got := ResolveArtifactPath(dir, "link.png"); got != link {
		t.Fatalf("symlink resolved to %q, want %q", got, link)
	}
}

// The encoded-size ceiling must equal the oracle's Math.ceil computation
// exactly, since it is the gate that refuses an oversized payload before it is
// expanded in memory. Measured: 69905067.
func TestMaxEncodedBytesMatchesTheOracle(t *testing.T) {
	if MaxEncodedBytesPerImage != 69905067 {
		t.Fatalf("MaxEncodedBytesPerImage = %d, oracle computes 69905067", MaxEncodedBytesPerImage)
	}
}

// JavaScript's \s is wider than Go's, so a payload carrying Unicode whitespace
// must still decode. RE2's \s is ASCII-only, which would leave the character in
// place and fail the strict alphabet check on input the oracle accepts.
func TestDecodeValidatedImageBase64StripsUnicodeWhitespace(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(pngBytes)
	for name, space := range map[string]string{
		"non-breaking space": "\u00a0",
		"figure space":       "\u2007",
		"byte order mark":    "\ufeff",
		"line separator":     "\u2028",
		"ideographic space":  "\u3000",
		"vertical tab":       "\v",
	} {
		spaced := encoded[:4] + space + encoded[4:]
		decoded, err := DecodeValidatedImageBase64(spaced)
		if err != nil || len(decoded) != len(pngBytes) {
			t.Fatalf("%s: decode = (%d, %v), oracle decodes it", name, len(decoded), err)
		}
	}
}
