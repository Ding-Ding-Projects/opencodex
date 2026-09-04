package claude

// Differential against src/images/synthetic-tool.ts, exercising the scan where
// it actually lives: the parser owns tool parsing, and putting the scan in the
// images package created an import cycle through config.

import (
	"encoding/json"
	"sort"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func toolList(t *testing.T, document string) []any {
	t.Helper()
	var tools []any
	if err := json.Unmarshal([]byte(document), &tools); err != nil {
		t.Fatal(err)
	}
	return tools
}

func sortedNames(result types.HostedImageTools) []string {
	names := append([]string(nil), result.ToolNames...)
	sort.Strings(names)
	return names
}

func equalNames(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range want {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// Oracle T1/T2/T3: no tools, no entries, and a function-only declaration all
// leave the bridge inactive. The third is the important one: a request that
// merely names a tool `image_gen` belongs to somebody else, and hijacking it
// would break an unrelated integration.
func TestHostedImageScanRequiresAHostedEntry(t *testing.T) {
	for _, testCase := range []struct{ name, tools string }{
		{"no tools", `[]`},
		{"function only", `[{"type":"function","name":"image_gen"}]`},
		{"unrelated function", `[{"type":"function","name":"generate_image"}]`},
	} {
		if _, ok := extractHostedImageGeneration(toolList(t, testCase.tools)); ok {
			t.Fatalf("%s activated the bridge", testCase.name)
		}
	}
	if _, ok := extractHostedImageGeneration(nil); ok {
		t.Fatal("a nil tool list activated the bridge")
	}
}

// Oracle T4/T5/T6: a hosted entry is identified by its TYPE, and an unnamed one
// reports the type as its name because that is what the request carried.
func TestHostedImageScanNamesTheHostedEntry(t *testing.T) {
	for _, testCase := range []struct {
		name, tools string
		want        []string
		wantType    string
	}{
		{"image_generation", `[{"type":"image_generation"}]`, []string{"image_generation"}, "image_generation"},
		{"image_gen", `[{"type":"image_gen"}]`, []string{"image_gen"}, "image_gen"},
		{"explicitly named", `[{"type":"image_generation","name":"custom"}]`, []string{"custom"}, "image_generation"},
	} {
		result, ok := extractHostedImageGeneration(toolList(t, testCase.tools))
		if !ok {
			t.Fatalf("%s did not activate the bridge", testCase.name)
		}
		if got := sortedNames(result); !equalNames(got, testCase.want) {
			t.Fatalf("%s names = %v, oracle returns %v", testCase.name, got, testCase.want)
		}
		if kind, _ := result.OriginalTool["type"].(string); kind != testCase.wantType {
			t.Fatalf("%s original = %q, oracle keeps %q", testCase.name, kind, testCase.wantType)
		}
	}
}

// Oracle T7/T8/T9: with a hosted entry present, conflicting client aliases are
// collected too. Matching ignores case but the recorded name is VERBATIM,
// because the caller has to strip exactly what the request declared.
func TestHostedImageScanCollectsConflictingAliases(t *testing.T) {
	result, ok := extractHostedImageGeneration(toolList(t,
		`[{"type":"image_generation"},{"type":"function","name":"generate_image"},{"type":"function","name":"unrelated"}]`))
	if !ok {
		t.Fatal("hosted entry with aliases did not activate the bridge")
	}
	if got, want := sortedNames(result), []string{"generate_image", "image_generation"}; !equalNames(got, want) {
		t.Fatalf("aliases = %v, oracle returns %v", got, want)
	}

	mixedCase, _ := extractHostedImageGeneration(toolList(t,
		`[{"type":"image_generation"},{"type":"function","name":"GenerateImage"}]`))
	if got, want := sortedNames(mixedCase), []string{"GenerateImage", "image_generation"}; !equalNames(got, want) {
		t.Fatalf("mixed case = %v, oracle preserves the original spelling: %v", got, want)
	}

	// The nested Chat Completions shape is accepted so a mixed client cannot
	// slip an alias past the scan.
	nested, _ := extractHostedImageGeneration(toolList(t,
		`[{"type":"image_generation"},{"type":"function","function":{"name":"imagegen"}}]`))
	if got, want := sortedNames(nested), []string{"image_generation", "imagegen"}; !equalNames(got, want) {
		t.Fatalf("nested function = %v, oracle returns %v", got, want)
	}
}

// Oracle T10/T11: two hosted entries both contribute names while the FIRST is
// kept as the original, and non-object entries are skipped rather than fatal.
func TestHostedImageScanHandlesMultipleAndJunkEntries(t *testing.T) {
	result, ok := extractHostedImageGeneration(toolList(t,
		`[{"type":"image_generation","name":"a"},{"type":"image_gen","name":"b"}]`))
	if !ok {
		t.Fatal("two hosted entries did not activate the bridge")
	}
	if got, want := sortedNames(result), []string{"a", "b"}; !equalNames(got, want) {
		t.Fatalf("names = %v, oracle returns %v", got, want)
	}
	if kind, _ := result.OriginalTool["type"].(string); kind != "image_generation" {
		t.Fatalf("original = %q, oracle keeps the FIRST hosted entry", kind)
	}

	junk, ok := extractHostedImageGeneration(toolList(t, `[null,{"type":"image_generation"},"string"]`))
	if !ok {
		t.Fatal("junk entries suppressed a real hosted tool")
	}
	if got, want := sortedNames(junk), []string{"image_generation"}; !equalNames(got, want) {
		t.Fatalf("junk names = %v, oracle returns %v", got, want)
	}
}
