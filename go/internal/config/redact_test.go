package config

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRedactKnownPatterns(t *testing.T) {
	input := `Authorization: Bearer abcdefghijklmnop apiKey=secret-value token sk-123456789 github_pat_abcdefghijklmnopqrstuvwxyz`
	got := RedactString(input)
	for _, secret := range []string{"abcdefghijklmnop", "secret-value", "sk-123456789", "github_pat_abcdefghijklmnopqrstuvwxyz"} {
		if strings.Contains(got, secret) {
			t.Fatalf("RedactString() leaked %q in %q", secret, got)
		}
	}
}

func TestRedactMap(t *testing.T) {
	input := map[string]any{
		"password": "secret",
		"nested":   map[string]any{"authorization": "Bearer abcdefghijk", "safe": "hello"},
	}
	want := map[string]any{
		"password": RedactedSecret,
		"nested":   map[string]any{"authorization": RedactedSecret, "safe": "hello"},
	}
	if got := RedactMap(input); !reflect.DeepEqual(got, want) {
		t.Fatalf("RedactMap() = %#v, want %#v", got, want)
	}
}

func TestRedactRawFieldsPreservesSafeUnknownsAndScrubsSecrets(t *testing.T) {
	fields := map[string]json.RawMessage{
		"futureFeature": json.RawMessage(`{"enabled":true,"accessToken":"future-secret"}`),
		"apiKey":        json.RawMessage(`"top-secret"`),
	}
	redacted := RedactRawFields(fields)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "future-secret") || strings.Contains(string(encoded), "top-secret") || !strings.Contains(string(encoded), "enabled") || !strings.Contains(string(encoded), RedactedSecret) {
		t.Fatalf("raw redaction = %s", encoded)
	}
}
