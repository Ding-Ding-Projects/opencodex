package google

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

func BenchmarkScanSSELongLine(b *testing.B) {
	// Apple M5 Pro, 1 MiB line: string concatenation baseline 543,158,253 B/op
	// and 3,100 allocs/op; buffered scanner 5,315,681 B/op and 16 allocs/op.
	for _, size := range []int{64 << 10, 1 << 20} {
		b.Run(fmt.Sprintf("bytes-%d", size), func(b *testing.B) {
			payload := "data: " + strings.Repeat("x", size) + "\n"
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for index := 0; index < b.N; index++ {
				accepted := 0
				_, err := scanSSE(&fixedChunkReader{data: payload, chunk: 1024}, func(string) scanSSEAction {
					accepted++
					return scanSSEContinue
				}, func() bool { return true })
				if err != nil {
					b.Fatal(err)
				}
				if accepted != 1 {
					b.Fatalf("accepted = %d", accepted)
				}
			}
		})
	}
}

func BenchmarkToolNameCodecInvalidNames(b *testing.B) {
	names := make([]string, 128)
	for index := range names {
		names[index] = fmt.Sprintf("%d invalid.tool name/%d", index, index)
	}
	b.ReportAllocs()
	for index := 0; index < b.N; index++ {
		codec := newToolNameCodec(names)
		if len(codec.forward) != len(names) {
			b.Fatalf("encoded names = %d", len(codec.forward))
		}
	}
}

type fixedChunkReader struct {
	data  string
	chunk int
}

func (reader *fixedChunkReader) Read(target []byte) (int, error) {
	if reader.data == "" {
		return 0, io.EOF
	}
	limit := min(len(target), reader.chunk, len(reader.data))
	copy(target, reader.data[:limit])
	reader.data = reader.data[limit:]
	return limit, nil
}
