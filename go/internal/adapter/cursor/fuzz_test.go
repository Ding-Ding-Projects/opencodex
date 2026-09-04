package cursor

import (
	"bytes"
	"reflect"
	"testing"
)

func FuzzCursorConnectFrame(f *testing.F) {
	valid, _ := EncodeFrame(ConnectFrame{Flags: ConnectFlagEndStream, Payload: []byte("안녕 🌍")})
	f.Add([]byte{})
	f.Add(valid)
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 1<<20 {
			t.Skip()
		}
		frame, err := ReadFrame(bytes.NewReader(data), 1<<20)
		if err == nil {
			encoded, encodeErr := EncodeFrame(frame)
			if encodeErr != nil {
				t.Fatalf("accepted frame cannot be encoded: %v", encodeErr)
			}
			roundTrip, decodeErr := ReadFrame(bytes.NewReader(encoded), 1<<20)
			if decodeErr != nil || !reflect.DeepEqual(frame, roundTrip) {
				t.Fatalf("round trip changed frame: frame=%#v roundTrip=%#v err=%v", frame, roundTrip, decodeErr)
			}
		}
		_, _ = NewEventParser().Parse(data)
		_, _ = parseFields(data)
		_ = ParseEndStreamTrailer(data)
	})
}
