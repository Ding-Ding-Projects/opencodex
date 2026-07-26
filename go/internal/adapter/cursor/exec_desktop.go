package cursor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type DesktopExecutorConfig struct {
	ComputerUseCommand, RecordScreenCommand, WorkingDirectory string
	Env                                                       map[string]string
	Timeout                                                   time.Duration
}
type ComputerUseRequest struct {
	ToolCallID string           `json:"toolCallId"`
	Actions    []map[string]any `json:"actions"`
}
type ComputerUseResult struct {
	Screenshot     string `json:"screenshot,omitempty"`
	ScreenshotPath string `json:"screenshotPath,omitempty"`
	Log            string `json:"log,omitempty"`
	DurationMS     int64  `json:"durationMs,omitempty"`
	ActionCount    int    `json:"actionCount,omitempty"`
}
type RecordScreenRequest struct{ Mode, ToolCallID, SaveAsFilename string }
type RecordScreenResult struct {
	Kind                    string
	Path                    string `json:"path,omitempty"`
	RecordingDurationMS     int64  `json:"recordingDurationMs,omitempty"`
	PriorRecordingCancelled bool   `json:"wasPriorRecordingCancelled,omitempty"`
	SaveAsFilenameIgnored   bool   `json:"wasSaveAsFilenameIgnored,omitempty"`
}

type DesktopExecutor struct{ Config DesktopExecutorConfig }

func (e DesktopExecutor) ComputerUse(ctx context.Context, req ComputerUseRequest) (ComputerUseResult, error) {
	if e.Config.ComputerUseCommand == "" {
		return ComputerUseResult{}, errorsNew("computer-use executor is not configured")
	}
	var envelope struct {
		ComputerUseResult
		Error string `json:"error"`
	}
	if err := e.runJSON(ctx, e.Config.ComputerUseCommand, req, &envelope); err != nil {
		return ComputerUseResult{}, err
	}
	if envelope.Error != "" {
		return ComputerUseResult{}, fmt.Errorf("computer-use executor: %s", envelope.Error)
	}
	result := envelope.ComputerUseResult
	result.ActionCount = len(req.Actions)
	return result, nil
}

func (e DesktopExecutor) RecordScreen(ctx context.Context, req RecordScreenRequest) (RecordScreenResult, error) {
	if e.Config.RecordScreenCommand == "" {
		return RecordScreenResult{}, errorsNew("record-screen executor is not configured")
	}
	payload := map[string]string{"mode": req.Mode, "toolCallId": req.ToolCallID, "saveAsFilename": req.SaveAsFilename}
	var raw map[string]json.RawMessage
	if err := e.runJSON(ctx, e.Config.RecordScreenCommand, payload, &raw); err != nil {
		return RecordScreenResult{}, err
	}
	for _, candidate := range []struct{ key, kind string }{{"startSuccess", "start"}, {"saveSuccess", "save"}, {"discardSuccess", "discard"}} {
		if data, ok := raw[candidate.key]; ok {
			var result RecordScreenResult
			if len(data) > 0 {
				_ = json.Unmarshal(data, &result)
			}
			result.Kind = candidate.kind
			return result, nil
		}
	}
	if data := raw["failure"]; len(data) > 0 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		return RecordScreenResult{}, fmt.Errorf("record-screen executor: %s", failure.Error)
	}
	return RecordScreenResult{}, errorsNew("record-screen executor returned no recognized result")
}

func (e DesktopExecutor) runJSON(parent context.Context, command string, payload, result any) error {
	timeout := e.Config.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	var shell string
	var args []string
	if runtime.GOOS == "windows" {
		shell = "cmd.exe"
		args = []string{"/d", "/s", "/c", command}
	} else {
		shell = "/bin/sh"
		args = []string{"-c", command}
	}
	input, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = e.Config.WorkingDirectory
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		if split := strings.IndexByte(entry, '='); split >= 0 {
			environment[entry[:split]] = entry[split+1:]
		}
	}
	for key, value := range e.Config.Env {
		environment[key] = value
	}
	cmd.Env = make([]string, 0, len(environment))
	for key, value := range environment {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("desktop executor timed out after %s", timeout)
		}
		return fmt.Errorf("desktop executor failed: %w: %s", err, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), result); err != nil {
		return fmt.Errorf("desktop executor produced invalid JSON: %w", err)
	}
	return nil
}
