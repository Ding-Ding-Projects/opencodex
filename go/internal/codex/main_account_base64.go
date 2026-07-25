package codex

import "encoding/base64"

func jwtBase64Decode(value string) ([]byte, error) {
	return base64.URLEncoding.DecodeString(value)
}
