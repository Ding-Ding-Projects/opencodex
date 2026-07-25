package cursor

import (
	"reflect"
	"testing"
)

func TestDecodeCursorArgValue(t *testing.T) {
	protobufString, err := MarshalValue(`{"path":"main.go"}`)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		data []byte
		want any
	}{
		{name: "protobuf string containing JSON", data: protobufString, want: map[string]any{"path": "main.go"}},
		{name: "raw JSON", data: []byte(`{"count":2}`), want: map[string]any{"count": float64(2)}},
		{name: "raw text", data: []byte("plain text"), want: "plain text"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DecodeCursorArgValue(tt.data); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("decoded value = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestDecodeCursorArgsMap(t *testing.T) {
	encoded, err := MarshalValue(true)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"enabled": true, "count": float64(3)}
	got := DecodeCursorArgsMap(map[string][]byte{"enabled": encoded, "count": []byte("3")})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded map = %#v, want %#v", got, want)
	}
}
