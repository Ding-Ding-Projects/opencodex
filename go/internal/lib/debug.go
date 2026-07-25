package lib

import (
	"encoding/json"
	"fmt"
	"io"
)

// DebugWriter is the destination for opt-in provider diagnostics. It defaults
// to discard so library use never writes process output implicitly.
var DebugWriter io.Writer = io.Discard

func emitDebugLine(line string) {
	if !IsDebugEnabled() {
		return
	}
	DefaultDebugLogBuffer.Append(line)
	_, _ = fmt.Fprintln(DebugWriter, line)
}

// DebugDroppedFrame records only the malformed payload size. The payload may
// contain prompts, credentials, or provider-private response data.
func DebugDroppedFrame(adapter, payload string) {
	if !IsDebugEnabled() {
		return
	}
	emitDebugLine(fmt.Sprintf("[ocx:frame-drop] %s: dropped malformed upstream frame (payload redacted, bytes=%d)", adapter, len(payload)))
}

// DebugProviderDiagnostic emits a redacted, provider-scoped JSON diagnostic.
// Marshal failures are intentionally ignored because diagnostics must never
// affect request handling.
func DebugProviderDiagnostic(adapter, event string, details map[string]any) {
	if !IsDebugEnabled() {
		return
	}
	encoded, err := json.Marshal(RedactSecrets(details))
	if err != nil {
		return
	}
	emitDebugLine(fmt.Sprintf("[ocx:%s:%s] %s", adapter, event, encoded))
}
