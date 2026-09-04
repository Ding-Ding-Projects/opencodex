package lib

import "github.com/lidge-jun/opencodex-go/internal/protocol"

type SSEEvent = protocol.SSEEvent
type SSEDecoder = protocol.SSEDecoder

func NewSSEDecoder(events chan<- SSEEvent) *SSEDecoder { return protocol.NewSSEDecoder(events) }
func NewSSEDecoderWithComments(events chan<- SSEEvent) *SSEDecoder {
	return protocol.NewSSEDecoderWithComments(events)
}
