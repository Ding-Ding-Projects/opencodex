package vision

import (
	"encoding/json"
	"strings"
	"testing"
)

func FuzzParseImageBoundary(f *testing.F) {
	for _, seed := range []string{
		"",
		"https://example.test/이미지.png",
		"http://example.test/image.png",
		"data:image/png;base64,",
		"data:image/png;base64,aGVsbG8=",
		"data:image/unknown;base64,aGVsbG8=",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if len(value) > 64<<10 {
			t.Skip()
		}
		image, err := ParseImage(value, ValidationOptions{MaxBytes: 4096, MaxEdge: 128, MaxPixels: 16_384})
		if err != nil {
			return
		}
		if image.URL != value {
			t.Fatalf("successful parse changed URL: got=%q want=%q", image.URL, value)
		}
		if len(image.Data) > 4096 || image.Width > 128 || image.Height > 128 {
			t.Fatalf("successful parse exceeded limits: %#v", image)
		}
	})
}

func FuzzImageReference(f *testing.F) {
	for _, seed := range []string{
		`{}`,
		`{"imageUrl":"https://example.test/이미지.png","detail":"high"}`,
		`{"source":{"type":"base64","media_type":"image/png","data":"aA=="}}`,
		`{"image_url":{"url":"https://example.test/x","detail":"low"}}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 128<<10 {
			t.Skip()
		}
		var part map[string]any
		if json.Unmarshal(raw, &part) != nil {
			return
		}
		value, detail, err := imageReference(part)
		if err == nil && strings.TrimSpace(value) == "" {
			t.Fatalf("successful image reference is empty: detail=%q part=%#v", detail, part)
		}
	})
}

func TestVisionUnicodeClampBoundary(t *testing.T) {
	value := strings.Repeat("界", 2001)
	clamped := clampDescription(value)
	if !strings.HasSuffix(clamped, "\n…[description truncated]") || len([]rune(strings.TrimSuffix(clamped, "\n…[description truncated]"))) != 2000 {
		t.Fatalf("unicode description clamp split a rune or used the wrong boundary")
	}
}
