package server

import "testing"

func TestRestoreMatchesTheOracleOnHostileInput(t *testing.T) {
	aliases := imageGenAliases()
	for _, testCase := range []struct{ name, in, want string }{
		{"duplicate keys", `{"type":"function_call","a":1,"a":2,"name":"image_gen__create"}`,
			`{"type":"function_call","a":2,"name":"create","namespace":"image_gen"}`},
		{"html characters", `{"type":"function_call","name":"image_gen__create","arguments":"a<b>&c"}`,
			`{"type":"function_call","name":"create","arguments":"a<b>&c","namespace":"image_gen"}`},
		{"unicode and surrogate pair", `{"type":"function_call","name":"image_gen__create","u":"\u00e9\ud83d\ude00"}`,
			`{"type":"function_call","name":"create","u":"é😀","namespace":"image_gen"}`},
		{"null value", `{"type":"function_call","name":"image_gen__create","n":null}`,
			`{"type":"function_call","name":"create","n":null,"namespace":"image_gen"}`},
		{"exponent float", `{"type":"function_call","name":"image_gen__create","f":1.5e10}`,
			`{"type":"function_call","name":"create","f":15000000000,"namespace":"image_gen"}`},
		{"negative zero", `{"type":"function_call","name":"image_gen__create","z":-0}`,
			`{"type":"function_call","name":"create","z":0,"namespace":"image_gen"}`},
		{"empty containers", `{"type":"function_call","name":"image_gen__create","e":{},"a":[]}`,
			`{"type":"function_call","name":"create","e":{},"a":[],"namespace":"image_gen"}`},
	} {
		if got := RestoreImageGenCallsInJSON(testCase.in, aliases); got != testCase.want {
			t.Fatalf("%s:\n got  %s\n want %s", testCase.name, got, testCase.want)
		}
	}
}
