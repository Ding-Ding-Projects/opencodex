package anthropic

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
)

const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func TestNormalizeAnthropicImagesResizesOversizedImage(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2401, 20))
	for x := 0; x < source.Bounds().Dx(); x++ {
		for y := 0; y < source.Bounds().Dy(); y++ {
			source.SetRGBA(x, y, color.RGBA{R: byte(x), G: byte(y), B: 80, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	block := imageBlock(base64.StdEncoding.EncodeToString(encoded.Bytes()))
	messages := []any{map[string]any{"role": "user", "content": []any{block}}}
	if err := NormalizeAnthropicImages(messages); err != nil {
		t.Fatal(err)
	}
	normalized := messages[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	normalizedSource := normalized["source"].(map[string]any)
	if normalizedSource["media_type"] != "image/jpeg" {
		t.Fatalf("media type = %#v", normalizedSource["media_type"])
	}
	dims, ok := SniffImageDimensions(normalizedSource["data"].(string))
	if !ok || dims.Width > ManyImageMaxDimension || dims.Height > ManyImageMaxDimension {
		t.Fatalf("normalized dimensions = %#v, %v", dims, ok)
	}
}

func TestNormalizeImageTargetsTierBiasAndCache(t *testing.T) {
	ResetNormalizeStateForTests()
	var edges []int
	encode := func(_ []byte, spec TierSpec, quality int) (EncodedImage, error) {
		edges = append(edges, spec.MaxEdge)
		return EncodedImage{Data: "normalized", MediaType: "image/jpeg"}, nil
	}
	var replacements []string
	target := NormalizeTarget{
		Base64: onePixelPNG, MediaType: "image/bmp",
		Replace: func(data, media string) error {
			replacements = append(replacements, data+":"+media)
			return nil
		},
		Drop: func(string) error { return nil },
	}
	options := NormalizeOptions{TierBias: 3, Encode: encode, Validate: func([]byte) error { return nil }}
	if err := NormalizeImageTargets([]NormalizeTarget{target}, options); err != nil {
		t.Fatal(err)
	}
	if len(edges) != 1 || edges[0] != 500 {
		t.Fatalf("tier edges = %#v", edges)
	}
	if len(replacements) != 1 || replacements[0] != "normalized:image/jpeg" {
		t.Fatalf("replacements = %#v", replacements)
	}
	if err := NormalizeImageTargets([]NormalizeTarget{target}, options); err != nil {
		t.Fatal(err)
	}
	stats := GetNormalizeStatsForTests()
	if stats.EncodeCalls != 1 || stats.CacheEntries != 1 {
		t.Fatalf("cache stats = %#v", stats)
	}
}

func TestNormalizeImageTargetsDemotesOldestAgainstAggregateBudget(t *testing.T) {
	ResetNormalizeStateForTests()
	sizes := map[int]int{2000: 80, 1024: 50, 700: 30, 500: 20, 400: 10, 320: 8}
	encode := func(_ []byte, spec TierSpec, _ int) (EncodedImage, error) {
		return EncodedImage{Data: string(bytes.Repeat([]byte{'x'}, sizes[spec.MaxEdge])), MediaType: "image/jpeg"}, nil
	}
	type wireTarget struct {
		size int
		drop bool
	}
	wires := make([]wireTarget, 3)
	targets := make([]NormalizeTarget, 3)
	for index := range targets {
		wire := &wires[index]
		targets[index] = NormalizeTarget{
			Base64: onePixelPNG, MediaType: "image/bmp",
			Replace: func(data, _ string) error { wire.size = len(data); return nil },
			Drop:    func(string) error { wire.drop = true; wire.size = 0; return nil },
		}
	}
	if err := NormalizeImageTargets(targets, NormalizeOptions{
		Budget: 120, Encode: encode, Validate: func([]byte) error { return nil },
	}); err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, wire := range wires {
		total += wire.size
		if wire.drop {
			t.Fatal("aggregate demotion dropped an image before terminal overflow")
		}
	}
	if total > 120 {
		t.Fatalf("normalized total = %d", total)
	}
	if wires[0].size > wires[2].size {
		t.Fatalf("oldest image retained more bytes than newest: %#v", wires)
	}
}

func TestNormalizeImageTargetsDropsOldestAtTerminalOverflow(t *testing.T) {
	ResetNormalizeStateForTests()
	encode := func(_ []byte, _ TierSpec, _ int) (EncodedImage, error) {
		return EncodedImage{Data: string(bytes.Repeat([]byte{'x'}, 80)), MediaType: "image/jpeg"}, nil
	}
	dropped := make([]bool, 3)
	targets := make([]NormalizeTarget, 3)
	for index := range targets {
		current := index
		targets[index] = NormalizeTarget{
			Base64: onePixelPNG, MediaType: "image/bmp",
			Replace: func(string, string) error { return nil },
			Drop: func(note string) error {
				if !bytes.Contains([]byte(note), []byte("provider request budget")) {
					t.Fatalf("drop note = %q", note)
				}
				dropped[current] = true
				return nil
			},
		}
	}
	if err := NormalizeImageTargets(targets, NormalizeOptions{
		TierBias: 5, Budget: 100, OverflowAction: OverflowDrop,
		Encode: encode, Validate: func([]byte) error { return nil },
	}); err != nil {
		t.Fatal(err)
	}
	if !dropped[0] || !dropped[1] || dropped[2] {
		t.Fatalf("terminal overflow drop order = %#v", dropped)
	}
}

func TestNormalizeImageTargetsPropagatesWireCallbackFailure(t *testing.T) {
	ResetNormalizeStateForTests()
	want := errors.New("wire mutation failed")
	err := NormalizeImageTargets([]NormalizeTarget{{
		Base64: onePixelPNG, MediaType: "image/bmp",
		Replace: func(string, string) error { return want },
		Drop:    func(string) error { return nil },
	}}, NormalizeOptions{
		Encode: func([]byte, TierSpec, int) (EncodedImage, error) {
			return EncodedImage{Data: "normalized", MediaType: "image/jpeg"}, nil
		},
		Validate: func([]byte) error { return nil },
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func TestNormalizeAnthropicImagesTextifiesCorruptPayload(t *testing.T) {
	block := imageBlock(base64.StdEncoding.EncodeToString([]byte("not an image")))
	messages := []any{map[string]any{"role": "user", "content": []any{block}}}
	if err := NormalizeAnthropicImages(messages); err != nil {
		t.Fatal(err)
	}
	normalized := messages[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if normalized["type"] != "text" || !bytes.Contains([]byte(normalized["text"].(string)), []byte("undecodable")) {
		t.Fatalf("normalized corrupt image = %#v", normalized)
	}
}
