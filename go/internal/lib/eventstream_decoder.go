package lib

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"time"
)

const (
	eventPreludeLength    = 8
	eventHeaderOffset     = 12
	eventMinimumLength    = 16
	maxEventMessageLength = 16 << 20
	maxEventHeadersLength = 128 << 10
)

type EventStreamMessage struct {
	Headers map[string]string
	Payload []byte
}

func EventStreamCRC32(data []byte) uint32 { return crc32.ChecksumIEEE(data) }

func DecodeEventStreamMessage(frame []byte) (EventStreamMessage, error) {
	if len(frame) < eventMinimumLength {
		return EventStreamMessage{}, errors.New("eventstream: frame too short")
	}
	total := int(binary.BigEndian.Uint32(frame[:4]))
	if total != len(frame) {
		return EventStreamMessage{}, fmt.Errorf("eventstream: framed length %d != buffer %d", total, len(frame))
	}
	if total > maxEventMessageLength {
		return EventStreamMessage{}, fmt.Errorf("eventstream: total length %d exceeds maximum", total)
	}
	headersLength := int(binary.BigEndian.Uint32(frame[4:8]))
	if EventStreamCRC32(frame[:eventPreludeLength]) != binary.BigEndian.Uint32(frame[8:12]) {
		return EventStreamMessage{}, errors.New("eventstream: prelude CRC mismatch")
	}
	if headersLength > maxEventHeadersLength || headersLength > total-eventMinimumLength {
		return EventStreamMessage{}, errors.New("eventstream: headers length exceeds frame payload")
	}
	if EventStreamCRC32(frame[:total-4]) != binary.BigEndian.Uint32(frame[total-4:]) {
		return EventStreamMessage{}, errors.New("eventstream: message CRC mismatch")
	}
	headers, err := decodeEventHeaders(frame[eventHeaderOffset : eventHeaderOffset+headersLength])
	if err != nil {
		return EventStreamMessage{}, err
	}
	payload := append([]byte(nil), frame[eventHeaderOffset+headersLength:total-4]...)
	return EventStreamMessage{Headers: headers, Payload: payload}, nil
}

func DecodeEventStream(reader io.Reader, accept func(EventStreamMessage) error) error {
	for {
		prelude := make([]byte, eventHeaderOffset)
		_, err := io.ReadFull(reader, prelude)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return errors.New("eventstream: truncated message at end of stream")
		}
		total := int(binary.BigEndian.Uint32(prelude[:4]))
		if total < eventMinimumLength || total > maxEventMessageLength {
			return fmt.Errorf("eventstream: invalid total length %d", total)
		}
		frame := make([]byte, total)
		copy(frame, prelude)
		if _, err := io.ReadFull(reader, frame[eventHeaderOffset:]); err != nil {
			return errors.New("eventstream: truncated message at end of stream")
		}
		message, err := DecodeEventStreamMessage(frame)
		if err != nil {
			return err
		}
		if err := accept(message); err != nil {
			return err
		}
	}
}

func EncodeEventStreamMessage(headers map[string]string, payload []byte) ([]byte, error) {
	headerBlock := make([]byte, 0)
	for name, value := range headers {
		if len(name) > 255 || len(value) > 65535 {
			return nil, errors.New("eventstream: header too long")
		}
		headerBlock = append(headerBlock, byte(len(name)))
		headerBlock = append(headerBlock, name...)
		headerBlock = append(headerBlock, 7, byte(len(value)>>8), byte(len(value)))
		headerBlock = append(headerBlock, value...)
	}
	total := eventHeaderOffset + len(headerBlock) + len(payload) + 4
	if total > maxEventMessageLength {
		return nil, errors.New("eventstream: frame exceeds maximum")
	}
	frame := make([]byte, total)
	binary.BigEndian.PutUint32(frame[:4], uint32(total))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(headerBlock)))
	binary.BigEndian.PutUint32(frame[8:12], EventStreamCRC32(frame[:8]))
	copy(frame[eventHeaderOffset:], headerBlock)
	copy(frame[eventHeaderOffset+len(headerBlock):], payload)
	binary.BigEndian.PutUint32(frame[total-4:], EventStreamCRC32(frame[:total-4]))
	return frame, nil
}

func decodeEventHeaders(data []byte) (map[string]string, error) {
	result := map[string]string{}
	for offset := 0; offset < len(data); {
		if offset+1 > len(data) {
			return nil, errors.New("eventstream: truncated header name length")
		}
		nameLength := int(data[offset])
		offset++
		if offset+nameLength+1 > len(data) {
			return nil, errors.New("eventstream: truncated header name")
		}
		name := string(data[offset : offset+nameLength])
		offset += nameLength
		valueType := data[offset]
		offset++
		need := func(length int) ([]byte, error) {
			if offset+length > len(data) {
				return nil, errors.New("eventstream: truncated header value")
			}
			value := data[offset : offset+length]
			offset += length
			return value, nil
		}
		switch valueType {
		case 0:
			result[name] = "true"
		case 1:
			result[name] = "false"
		case 2:
			value, err := need(1)
			if err != nil {
				return nil, err
			}
			result[name] = fmt.Sprint(int8(value[0]))
		case 3:
			value, err := need(2)
			if err != nil {
				return nil, err
			}
			result[name] = fmt.Sprint(int16(binary.BigEndian.Uint16(value)))
		case 4:
			value, err := need(4)
			if err != nil {
				return nil, err
			}
			result[name] = fmt.Sprint(int32(binary.BigEndian.Uint32(value)))
		case 5:
			value, err := need(8)
			if err != nil {
				return nil, err
			}
			result[name] = fmt.Sprint(int64(binary.BigEndian.Uint64(value)))
		case 6, 7:
			lengthBytes, err := need(2)
			if err != nil {
				return nil, err
			}
			value, err := need(int(binary.BigEndian.Uint16(lengthBytes)))
			if err != nil {
				return nil, err
			}
			if valueType == 6 {
				result[name] = base64.StdEncoding.EncodeToString(value)
			} else {
				result[name] = string(value)
			}
		case 8:
			value, err := need(8)
			if err != nil {
				return nil, err
			}
			result[name] = time.UnixMilli(int64(binary.BigEndian.Uint64(value))).UTC().Format(time.RFC3339Nano)
		case 9:
			value, err := need(16)
			if err != nil {
				return nil, err
			}
			result[name] = fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
		default:
			return nil, fmt.Errorf("eventstream: unknown header value type %d", valueType)
		}
	}
	return result, nil
}
