package server

import "testing"

func TestRawSliceHandlesAwkwardPositions(t *testing.T) {
	aliases := imageGenAliases()
	for _, testCase := range []struct{ name, in, want string }{
		// A key containing a quote, right before the surrogate value.
		{"quote in key", `{"type":"function_call","name":"image_gen__create","a\"b":"\ud800"}`,
			`{"type":"function_call","name":"create","a\"b":"\ud800","namespace":"image_gen"}`},
		// Surrogate as an ARRAY element, where there is no preceding colon.
		{"array element", `{"type":"function_call","name":"image_gen__create","a":["\ud800"]}`,
			`{"type":"function_call","name":"create","a":["\ud800"],"namespace":"image_gen"}`},
		// Deeply nested.
		{"nested", `{"type":"function_call","name":"image_gen__create","a":{"b":{"c":"\ud800"}}}`,
			`{"type":"function_call","name":"create","a":{"b":{"c":"\ud800"}},"namespace":"image_gen"}`},
		// A backslash-heavy sibling string before the surrogate.
		{"escaped siblings", `{"type":"function_call","name":"image_gen__create","p":"a\\b\"c","q":"\ud800"}`,
			`{"type":"function_call","name":"create","p":"a\\b\"c","q":"\ud800","namespace":"image_gen"}`},
		// The oracle NORMALIZES the escape to lowercase, measured: \uD800 comes
		// back as \ud800. Preserving the original spelling here would be more
		// faithful to the input and less faithful to the oracle.
		{"uppercase escape", `{"type":"function_call","name":"image_gen__create","s":"\uD800"}`,
			`{"type":"function_call","name":"create","s":"\ud800","namespace":"image_gen"}`},
	} {
		if got := RestoreImageGenCallsInJSON(testCase.in, aliases); got != testCase.want {
			t.Fatalf("%s:\n got  %s\n want %s", testCase.name, got, testCase.want)
		}
	}
}
