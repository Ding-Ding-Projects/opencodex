package parity_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/grok"
)

func compareLifecycleBytes(t *testing.T, scenario string, goBytes, tsBytes []byte) {
	t.Helper()
	if !bytes.Equal(goBytes, tsBytes) {
		t.Fatalf("%s differs at offset %d: Go(len=%d sha=%s)=%q TypeScript(len=%d sha=%s)=%q", scenario, firstDifferentByte(goBytes, tsBytes), len(goBytes), payloadDigest(goBytes), goBytes, len(tsBytes), payloadDigest(tsBytes), tsBytes)
	}
}

func compareGrokLifecycleInjection(t *testing.T, goBytes, tsBytes []byte) {
	t.Helper()
	if !bytes.Equal(goBytes, tsBytes) {
		t.Logf("DIFFERENTIAL GAP: Grok CLI catalog bytes differ: Go(len=%d sha=%s) TypeScript(len=%d sha=%s)", len(goBytes), payloadDigest(goBytes), len(tsBytes), payloadDigest(tsBytes))
		if os.Getenv("OCX_REVEAL_KNOWN_DIFFS") == "1" {
			t.Logf("GROK DIFFERENTIAL BYTES\nGo=%s\nTypeScript=%s", goBytes, tsBytes)
		}
	}
	for runtime, config := range map[string][]byte{"Go": goBytes, "TypeScript": tsBytes} {
		if !bytes.Contains(config, []byte(grok.BeginMarker)) || !bytes.Contains(config, []byte(grok.EndMarker)) || !bytes.Contains(config, []byte("base_url = \"http://127.0.0.1:")) {
			t.Fatalf("%s Grok lifecycle injection is incomplete", runtime)
		}
	}
}

func compareRoutedLifecycleResponse(t *testing.T, goBytes, tsBytes []byte) {
	t.Helper()
	var goBody, tsBody map[string]any
	if err := json.Unmarshal(goBytes, &goBody); err != nil {
		t.Fatalf("decode Go lifecycle route response: %v: %s", err, goBytes)
	}
	if err := json.Unmarshal(tsBytes, &tsBody); err != nil {
		t.Fatalf("decode TypeScript lifecycle route response: %v: %s", err, tsBytes)
	}
	for _, key := range []string{"object", "model", "choices", "usage"} {
		goValue, _ := json.Marshal(goBody[key])
		tsValue, _ := json.Marshal(tsBody[key])
		if !bytes.Equal(goValue, tsValue) {
			t.Fatalf("routed lifecycle response %s differs: Go=%s TypeScript=%s", key, goValue, tsValue)
		}
	}
}

func compareDesktopLifecycleConfig(t *testing.T, goBytes, tsBytes []byte) {
	t.Helper()
	if !bytes.Equal(goBytes, tsBytes) {
		t.Logf("DIFFERENTIAL GAP: Claude Desktop CLI catalog bytes differ: Go(len=%d sha=%s) TypeScript(len=%d sha=%s)", len(goBytes), payloadDigest(goBytes), len(tsBytes), payloadDigest(tsBytes))
	}
	var goConfig, tsConfig map[string]any
	if err := json.Unmarshal(goBytes, &goConfig); err != nil {
		t.Fatalf("decode Go Claude Desktop config: %v", err)
	}
	if err := json.Unmarshal(tsBytes, &tsConfig); err != nil {
		t.Fatalf("decode TypeScript Claude Desktop config: %v", err)
	}
	for _, key := range []string{"inferenceProvider", "inferenceCredentialKind", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "modelDiscoveryEnabled"} {
		if fmt.Sprint(goConfig[key]) != fmt.Sprint(tsConfig[key]) {
			t.Fatalf("Claude Desktop %s differs: Go=%v TypeScript=%v", key, goConfig[key], tsConfig[key])
		}
	}
	goModel := findDesktopParityModel(goConfig)
	tsModel := findDesktopParityModel(tsConfig)
	goModelBytes, _ := json.Marshal(goModel)
	tsModelBytes, _ := json.Marshal(tsModel)
	if goModel == nil || tsModel == nil || !bytes.Equal(goModelBytes, tsModelBytes) {
		t.Fatalf("shared Claude Desktop parity model differs: Go=%s TypeScript=%s", goModelBytes, tsModelBytes)
	}
}

func findDesktopParityModel(config map[string]any) map[string]any {
	models, _ := config["inferenceModels"].([]any)
	for _, value := range models {
		model, _ := value.(map[string]any)
		if strings.Contains(fmt.Sprint(model["labelOverride"]), "Success (parity)") {
			return model
		}
	}
	return nil
}
