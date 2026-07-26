package lib

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

type gracefulStopResult uint8

const (
	gracefulStopUnavailable gracefulStopResult = iota
	gracefulStopAccepted
	gracefulStopRefused
)

// StopProxy asks the management API to drain first. A 409 is an ownership
// refusal and must never be escalated into a forced kill.
func StopProxy(ctx context.Context, pid int, baseURL, token string) error {
	if !platform.ProcessAlive(pid) {
		return nil
	}
	result, reason := requestGracefulProxyStop(ctx, http.DefaultClient, baseURL, token)
	if result == gracefulStopRefused {
		if reason == "" {
			reason = "a service installed under a different CODEX_HOME/OPENCODEX_HOME owns it"
		}
		return fmt.Errorf("running proxy refused to stop: %s", reason)
	}
	if result == gracefulStopAccepted && platform.WaitForExit(ctx, pid) {
		return nil
	}
	return platform.KillProcess(ctx, pid)
}

func requestGracefulProxyStop(ctx context.Context, client *http.Client, baseURL, token string) (gracefulStopResult, string) {
	if strings.TrimSpace(baseURL) == "" {
		return gracefulStopUnavailable, ""
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/stop", nil)
	if err != nil {
		return gracefulStopUnavailable, ""
	}
	if token != "" {
		request.Header.Set("x-opencodex-api-key", token)
	}
	response, err := client.Do(request)
	if err != nil {
		return gracefulStopUnavailable, ""
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		var payload struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &payload)
		return gracefulStopRefused, strings.TrimSpace(payload.Error)
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return gracefulStopAccepted, ""
	}
	return gracefulStopUnavailable, ""
}
