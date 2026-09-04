package images

// Differential against src/images/synthetic-tool.ts. Every expectation was
// captured by RUNNING the oracle.

import (
	"encoding/json"
	"testing"
)

// Oracle T12: only the two canonical spellings identify a CALL. A call arriving
// as `generate_image` came from a real client tool the bridge replaced, not
// from the synthetic one, so it must not be intercepted.
func TestIsImageGenNameMatchesTheOracle(t *testing.T) {
	for name, want := range map[string]bool{
		"image_gen":        true,
		"IMAGE_GEN":        true,
		"image_generation": true,
		"imagegen":         false,
		"generate_image":   false,
		"":                 false,
	} {
		if got := IsImageGenName(name); got != want {
			t.Fatalf("IsImageGenName(%q) = %v, oracle returns %v", name, got, want)
		}
	}
}

// Oracle T13/T14: the synthetic tool's exact shape, since the model sees it.
func TestBuildImageToolMatchesTheOracle(t *testing.T) {
	tool := BuildImageTool()
	if tool.Name != ImageGenToolName || ImageGenToolName != "image_gen" {
		t.Fatalf("name = %q", tool.Name)
	}
	if !tool.ImageGeneration {
		t.Fatal("the synthetic tool is not flagged for interception")
	}
	encoded, err := json.Marshal(tool.Parameters)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"properties":{"n":{"maximum":4,"minimum":1,"type":"integer"},` +
		`"prompt":{"description":"Detailed image generation prompt. Required.","type":"string"}},` +
		`"required":["prompt"],"type":"object"}`
	if string(encoded) != want {
		t.Fatalf("parameters = %s\nwant %s", encoded, want)
	}
}
