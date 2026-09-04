package parity_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestTypeScriptAndGoStorageRouteSemanticParity(t *testing.T) {
	config := differentialConfig("https://storage.invalid", []string{"probe"})
	setup := func(home string) {
		codexHome := filepath.Join(home, "codex")
		sessions := filepath.Join(codexHome, "sessions")
		if err := os.MkdirAll(sessions, 0o700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(sessions, "turn.jsonl")
		if err := os.WriteFile(path, []byte("turn\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		fixed := time.Unix(1_700_000_000, 0)
		if err := os.Chtimes(path, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}

	tsProxy := startTypeScriptProxyWithSetup(t, config, setup)
	goProxy := startProxyWithSetup(t, config, setup)
	goResult := captureManagementRequest(t, goProxy.baseURL, http.MethodGet, "/api/storage", "", nil)
	tsResult := captureManagementRequest(t, tsProxy.baseURL, http.MethodGet, "/api/storage", "", nil)
	goResult.body = normalizeStorageDynamics(t, goResult.body, filepath.Join(goProxy.home, "codex"))
	tsResult.body = normalizeStorageDynamics(t, tsResult.body, filepath.Join(tsProxy.home, "codex"))
	assertStorageSemanticParity(t, goResult.body, tsResult.body)
	if !bytes.Equal(goResult.body, tsResult.body) {
		t.Logf("SEMANTIC-ONLY DIFFERENTIAL [storage/report]: Go sha=%s TypeScript sha=%s (bucket key order)", payloadDigest(goResult.body), payloadDigest(tsResult.body))
	}
}

func assertStorageSemanticParity(t *testing.T, goBody, tsBody []byte) {
	t.Helper()
	var goValue, tsValue any
	if err := json.Unmarshal(goBody, &goValue); err != nil {
		t.Fatalf("decode Go storage report: %v", err)
	}
	if err := json.Unmarshal(tsBody, &tsValue); err != nil {
		t.Fatalf("decode TypeScript storage report: %v", err)
	}
	if !reflect.DeepEqual(goValue, tsValue) {
		t.Fatalf("storage semantic report differs: Go=%#v TypeScript=%#v", goValue, tsValue)
	}
}

func normalizeStorageDynamics(t *testing.T, body []byte, codexHome string) []byte {
	t.Helper()
	encodedHome, err := json.Marshal(codexHome)
	if err != nil {
		t.Fatal(err)
	}
	normalized := bytes.ReplaceAll(body, encodedHome, []byte(`"<codex-home>"`))
	return managementUsageTimePattern.ReplaceAll(normalized, []byte(`"$1":0`))
}
