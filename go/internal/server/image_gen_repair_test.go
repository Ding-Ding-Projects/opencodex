package server

// Differential against src/server/responses-image-gen-repair.ts. Every
// expectation was captured by RUNNING the oracle.

import (
	"encoding/json"
	"sort"
	"testing"
)

func aliasSummary(aliases map[string]NamespacedTool) []string {
	out := make([]string, 0, len(aliases))
	for wire, tool := range aliases {
		out = append(out, wire+"="+tool.Namespace+"/"+tool.Name)
	}
	sort.Strings(out)
	return out
}

func decodeBody(t *testing.T, text string) any {
	t.Helper()
	var body any
	if err := json.Unmarshal([]byte(text), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// Oracle I1/I2: only the image-gen namespace produces aliases, and each tool
// yields BOTH the flat wire name and the dotted spelling.
func TestImageGenToolCallAliasesFromNamespaceMap(t *testing.T) {
	aliases := ImageGenToolCallAliases(map[string]NamespacedTool{
		"image_gen__create": {Namespace: "image_gen", Name: "create"},
		"other__thing":      {Namespace: "other", Name: "thing"},
	}, nil)
	got := aliasSummary(aliases)
	want := []string{"image_gen.create=image_gen/create", "image_gen__create=image_gen/create"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("aliases = %v, oracle returns %v", got, want)
	}
	if len(ImageGenToolCallAliases(nil, nil)) != 0 {
		t.Fatal("an empty input produced aliases")
	}
}

// Oracle I3/I4: legacy flat dotted declarations are recovered from the raw
// request, including inside an additional_tools input item. A bare prefix with
// no local name and a non-function entry are both ignored.
func TestImageGenToolCallAliasesFromRequestBody(t *testing.T) {
	body := decodeBody(t, `{"tools":[
		{"type":"function","name":"image_gen.legacy"},
		{"type":"function","name":"image_gen."},
		{"type":"function","name":"notimage.x"},
		{"type":"other","name":"image_gen.skipped"}]}`)
	got := aliasSummary(ImageGenToolCallAliases(nil, body))
	want := []string{"image_gen.legacy=image_gen/legacy", "image_gen__legacy=image_gen/legacy"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("body aliases = %v, oracle returns %v", got, want)
	}

	nested := decodeBody(t, `{"input":[{"type":"additional_tools","tools":[{"type":"function","name":"image_gen.nested"}]}]}`)
	got = aliasSummary(ImageGenToolCallAliases(nil, nested))
	want = []string{"image_gen.nested=image_gen/nested", "image_gen__nested=image_gen/nested"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("additional_tools aliases = %v, oracle returns %v", got, want)
	}
}

func imageGenAliases() map[string]NamespacedTool {
	return ImageGenToolCallAliases(map[string]NamespacedTool{
		"image_gen__create": {Namespace: "image_gen", Name: "create"},
		"other__thing":      {Namespace: "other", Name: "thing"},
	}, nil)
}

// Oracle I5/I6/I9: both spellings restore, and nesting is followed. Field order
// is preserved with the namespace appended, which is what the oracle emits.
func TestRestoreImageGenCallsRewritesBothSpellings(t *testing.T) {
	aliases := imageGenAliases()
	for _, testCase := range []struct{ in, want string }{
		{
			in:   `{"type":"function_call","name":"image_gen__create","arguments":"{}"}`,
			want: `{"type":"function_call","name":"create","arguments":"{}","namespace":"image_gen"}`,
		},
		{
			in:   `{"type":"function_call","name":"image_gen.create"}`,
			want: `{"type":"function_call","name":"create","namespace":"image_gen"}`,
		},
		{
			in:   `{"a":[{"b":{"type":"function_call","name":"image_gen__create"}}]}`,
			want: `{"a":[{"b":{"type":"function_call","name":"create","namespace":"image_gen"}}]}`,
		},
	} {
		if got := RestoreImageGenCallsInJSON(testCase.in, aliases); got != testCase.want {
			t.Fatalf("restore(%s) = %s, oracle returns %s", testCase.in, got, testCase.want)
		}
	}
}

// Oracle I7/I8/E2/E4: the rewrite is STRUCTURAL. A message carrying the same
// string, an unrelated namespace, and the alias appearing inside an argument
// string are all left alone. A textual replace would corrupt every one of
// these, which is why the first implementation of this was thrown away.
func TestRestoreImageGenCallsOnlyTouchesFunctionCalls(t *testing.T) {
	aliases := imageGenAliases()
	for _, testCase := range []struct{ name, in string }{
		{name: "unrelated namespace", in: `{"type":"function_call","name":"other__thing"}`},
		{name: "non-call with the same name", in: `{"type":"message","name":"image_gen__create"}`},
	} {
		if got := RestoreImageGenCallsInJSON(testCase.in, aliases); got != testCase.in {
			t.Fatalf("%s: restore = %s, oracle leaves it unchanged", testCase.name, got)
		}
	}

	// The alias inside an argument STRING must survive verbatim while the
	// call's own name is restored.
	in := `{"type":"function_call","name":"image_gen__create","arguments":"{\"name\":\"image_gen__create\"}"}`
	want := `{"type":"function_call","name":"create","arguments":"{\"name\":\"image_gen__create\"}","namespace":"image_gen"}`
	if got := RestoreImageGenCallsInJSON(in, aliases); got != want {
		t.Fatalf("argument-string restore = %s, oracle returns %s", got, want)
	}

	// A sibling message and a real call in one document: only the call moves.
	mixed := `{"a":{"type":"message","name":"image_gen__create"},"b":{"type":"function_call","name":"image_gen__create"}}`
	wantMixed := `{"a":{"type":"message","name":"image_gen__create"},"b":{"type":"function_call","name":"create","namespace":"image_gen"}}`
	if got := RestoreImageGenCallsInJSON(mixed, aliases); got != wantMixed {
		t.Fatalf("mixed restore = %s, oracle returns %s", got, wantMixed)
	}
}

// Oracle I10/I11/I12: unparseable text, an empty alias set, and a document that
// needs no change all return the ORIGINAL bytes, whitespace included.
func TestRestoreImageGenCallsReturnsOriginalBytesWhenNothingChanges(t *testing.T) {
	aliases := imageGenAliases()
	if got := RestoreImageGenCallsInJSON("not json", aliases); got != "not json" {
		t.Fatalf("invalid JSON = %q, oracle returns it unchanged", got)
	}
	call := `{"type":"function_call","name":"image_gen__create"}`
	if got := RestoreImageGenCallsInJSON(call, nil); got != call {
		t.Fatalf("no aliases = %q, oracle returns it unchanged", got)
	}
	spaced := `{"type":"message",  "x":1}`
	if got := RestoreImageGenCallsInJSON(spaced, aliases); got != spaced {
		t.Fatalf("unchanged document = %q, oracle preserves the original spacing", got)
	}
}

// Oracle I13: no aliases means no rewrite at all, so the caller can skip
// wrapping the stream instead of paying for an identity pass.
func TestCreateImageGenCallRestoreRewriteIsNilWithoutAliases(t *testing.T) {
	if CreateImageGenCallRestoreRewrite(nil) != nil {
		t.Fatal("an empty alias set produced a rewrite")
	}
	rewrite := CreateImageGenCallRestoreRewrite(imageGenAliases())
	if rewrite == nil {
		t.Fatal("a populated alias set produced no rewrite")
	}
	in := `{"type":"function_call","name":"image_gen__create"}`
	want := `{"type":"function_call","name":"create","namespace":"image_gen"}`
	if got := rewrite(in); got != want {
		t.Fatalf("rewrite = %s, want %s", got, want)
	}
}

// Key order must survive, because Go's default map encoding sorts keys and the
// oracle does not.
//
// Numbers deliberately match the oracle rather than beating it: JSON.parse is
// float64-backed, so the twenty-digit id below loses its tail on BOTH sides.
// Measured against the oracle, which returns 12345678901234567000.
func TestRestorePreservesKeyOrderAndMatchesOracleNumbers(t *testing.T) {
	aliases := imageGenAliases()
	in := `{"zeta":1,"alpha":2,"id":12345678901234567890,"call":{"type":"function_call","name":"image_gen__create"}}`
	want := `{"zeta":1,"alpha":2,"id":12345678901234567000,"call":{"type":"function_call","name":"create","namespace":"image_gen"}}`
	if got := RestoreImageGenCallsInJSON(in, aliases); got != want {
		t.Fatalf("restore = %s, want %s", got, want)
	}
}
