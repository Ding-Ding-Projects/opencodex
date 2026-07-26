package types

import (
	"encoding/json"
	"testing"
)

func FuzzContentCodec(f *testing.F) {
	for _, seed := range []string{
		`null`,
		`""`,
		`"안녕 🌍"`,
		`[]`,
		`[{"tYpe":"text","Arguments":{}}]`,
		`[{"type":"text","text":"a"},{"type":"thinking","thinking":"b","signature":"sig"},{"type":"toolCall","id":"c","name":"run","arguments":{}}]`,
		`[{"type":"image","imageUrl":"https://example.test/이미지.png","detail":"high"}]`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256<<10 {
			t.Skip()
		}
		text, parts, err := DecodeContent(raw)
		if err != nil {
			return
		}
		if text != nil {
			roundText, roundParts, roundErr := DecodeContent(EncodeTextContent(*text))
			if roundErr != nil || roundText == nil || *roundText != *text || roundParts != nil {
				t.Fatalf("text round trip changed: text=%q round=%v parts=%#v err=%v", *text, roundText, roundParts, roundErr)
			}
			return
		}
		if parts == nil {
			return
		}
		encoded, encodeErr := EncodeContentParts(parts)
		if encodeErr != nil || !json.Valid(encoded) {
			t.Fatalf("accepted parts cannot be encoded: %v", encodeErr)
		}
		_, roundParts, roundErr := DecodeContent(encoded)
		if roundErr != nil {
			t.Fatalf("canonical parts cannot be decoded: %v", roundErr)
		}
		roundEncoded, roundEncodeErr := EncodeContentParts(roundParts)
		if roundEncodeErr != nil || string(encoded) != string(roundEncoded) {
			t.Fatalf("canonical wire is not idempotent: first=%s second=%s err=%v", encoded, roundEncoded, roundEncodeErr)
		}
	})
}
