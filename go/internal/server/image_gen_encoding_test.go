package server

import (
	"strings"
	"testing"
)

// Round-two encoding divergences, each measured against the oracle.
func TestRestoreMatchesTheOracleOnEncodingEdges(t *testing.T) {
	aliases := imageGenAliases()
	for _, testCase := range []struct{ name, in, want string }{
		// A literal too large for float64 becomes Infinity in JavaScript, which
		// JSON.stringify writes as null. Failing the decode instead would leave
		// the whole document unrestored.
		{"overflowing number", `{"type":"function_call","name":"image_gen__create","n":1e400}`,
			`{"type":"function_call","name":"create","n":null,"namespace":"image_gen"}`},
		// A string holding BOTH a real U+FFFD and a lone surrogate decodes to
		// two replacement characters where the source spelled one, so counting
		// is what tells loss apart from content.
		{"real replacement plus surrogate", `{"type":"function_call","name":"image_gen__create","s":"\ufffd\ud800"}`,
			"{\"type\":\"function_call\",\"name\":\"create\",\"s\":\"\ufffd\\ud800\",\"namespace\":\"image_gen\"}"},
		// A lone surrogate in a property NAME is corrupted just as readily as
		// one in a value.
		{"surrogate in a key", `{"\ud800":"v","type":"function_call","name":"image_gen__create"}`,
			`{"\ud800":"v","type":"function_call","name":"create","namespace":"image_gen"}`},
		// Negative zero inside an array: slices are encoded by json.Marshal
		// directly, so a top-level-only normalization would miss this.
		{"negative zero in an array", `{"type":"function_call","name":"image_gen__create","a":[-0]}`,
			`{"type":"function_call","name":"create","a":[0],"namespace":"image_gen"}`},
	} {
		if got := RestoreImageGenCallsInJSON(testCase.in, aliases); got != testCase.want {
			t.Fatalf("%s:\n got  %s\n want %s", testCase.name, got, testCase.want)
		}
	}
}

// U+2028 and U+2029 stay literal. Go's encoder escapes them unconditionally,
// even with HTML escaping disabled, while JSON.stringify does not.
func TestRestoreKeepsLineSeparatorsLiteral(t *testing.T) {
	aliases := imageGenAliases()
	in := "{\"type\":\"function_call\",\"name\":\"image_gen__create\",\"s\":\"a\u2028b\u2029c\"}"
	want := "{\"type\":\"function_call\",\"name\":\"create\",\"s\":\"a\u2028b\u2029c\",\"namespace\":\"image_gen\"}"
	got := RestoreImageGenCallsInJSON(in, aliases)
	if got != want {
		t.Fatalf("line separators escaped:\n got  %q\n want %q", got, want)
	}
	if strings.Contains(got, `\u2028`) || strings.Contains(got, `\u2029`) {
		t.Fatalf("output still carries an escaped separator: %q", got)
	}
}

// Forward-auth routes are left raw: the client authenticated with the upstream
// directly, so its private namespace is not ours to rewrite.
func TestForwardRouteProducesNoAliases(t *testing.T) {
	core := &ResponsesCore{}
	request := imageToolRequest()
	if core.imageGenAliases(request, true) != nil {
		t.Fatal("a forward-auth route produced restore aliases")
	}
	if core.imageGenAliases(request, false) == nil {
		t.Fatal("a normal route produced no aliases")
	}
}
