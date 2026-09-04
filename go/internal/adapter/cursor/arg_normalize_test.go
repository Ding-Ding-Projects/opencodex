package cursor

import (
	"reflect"
	"testing"
)

func TestNormalizeArgKeysUsesDeclaredCanonicalNames(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{
		"path":       map[string]any{"type": "string"},
		"old_string": map[string]any{"type": "string"},
		"new_string": map[string]any{"type": "string"},
	}}
	arguments := map[string]any{
		"filepath":   "main.go",
		"oldText":    "before",
		"newcontent": "after",
		"unknown":    true,
	}
	want := map[string]any{
		"path":       "main.go",
		"old_string": "before",
		"new_string": "after",
		"unknown":    true,
	}
	if got := NormalizeArgKeys(arguments, schema); !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized arguments = %#v, want %#v", got, want)
	}
}

func TestNormalizeArgKeysCanonicalWinsAndUndeclaredAliasStays(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{"path": map[string]any{}}}
	arguments := map[string]any{"file": "alias", "path": "canonical", "cmd": "pwd"}
	want := map[string]any{"path": "canonical", "cmd": "pwd"}
	if got := NormalizeArgKeys(arguments, schema); !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized arguments = %#v, want %#v", got, want)
	}
}

func TestNormalizeArgKeysReturnsOriginalWhenUnchanged(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{"path": map[string]any{}}}
	arguments := map[string]any{"path": "main.go"}
	got := NormalizeArgKeys(arguments, schema)
	got["mutated"] = true
	if arguments["mutated"] != true {
		t.Fatal("unchanged normalization did not return the original map")
	}
}
