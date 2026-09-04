package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	WinSWVersion   = "2.12.0"
	WinSWURL       = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe"
	WinSWSHA256    = "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f"
	WinSWServiceID = "opencodex-proxy-native"
	maxWinSWBytes  = 2 << 20
)

type WinSWStatus string

const (
	WinSWStarted     WinSWStatus = "started"
	WinSWStopped     WinSWStatus = "stopped"
	WinSWNonexistent WinSWStatus = "nonexistent"
	WinSWUnknown     WinSWStatus = "unknown"
)

type WinSWConfig struct {
	Config
	ConfigDir        string
	TokenFile        string
	AccountDomain    string
	AccountUser      string
	DownloadURL      string
	ExpectedSHA256   string
	DownloadMaxBytes int64
}

func WinSWDirectory(configDir string) string { return filepath.Join(configDir, "winsw") }
func WinSWExecutablePath(configDir string) string {
	return filepath.Join(WinSWDirectory(configDir), WinSWServiceID+".exe")
}
func WinSWXMLPath(configDir string) string {
	return filepath.Join(WinSWDirectory(configDir), WinSWServiceID+".xml")
}

func ParseWinSWStatus(output string) WinSWStatus {
	normalized := strings.ToLower(strings.TrimSpace(output))
	switch {
	case strings.Contains(normalized, "nonexistent"):
		return WinSWNonexistent
	case strings.Contains(normalized, "started"):
		return WinSWStarted
	case strings.Contains(normalized, "stopped"):
		return WinSWStopped
	default:
		return WinSWUnknown
	}
}

func GenerateWinSWXML(config WinSWConfig) (string, error) {
	if err := ValidateConfig(config.Config); err != nil {
		return "", err
	}
	if strings.TrimSpace(config.AccountUser) == "" {
		return "", fmt.Errorf("WinSW account user must not be blank")
	}
	if strings.TrimSpace(config.TokenFile) == "" {
		return "", fmt.Errorf("WinSW token file must not be blank")
	}
	arguments := make([]string, len(config.Arguments))
	for index, argument := range config.Arguments {
		arguments[index] = windowsQuote(argument)
	}
	environment := make(map[string]string, len(config.Environment)+2)
	for key, value := range config.Environment {
		environment[key] = value
	}
	environment["OCX_SERVICE"] = "1"
	environment["OCX_API_TOKEN_FILE"] = config.TokenFile
	var builder strings.Builder
	builder.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<service>\n")
	writeWinSWElement(&builder, "id", WinSWServiceID, 2)
	writeWinSWElement(&builder, "name", "OpenCodex Proxy (native)", 2)
	writeWinSWElement(&builder, "description", "OpenCodex proxy running as a native Windows service (windowless, starts at boot).", 2)
	writeWinSWElement(&builder, "executable", config.Executable, 2)
	writeWinSWElement(&builder, "arguments", strings.Join(arguments, " "), 2)
	for _, key := range sortedKeys(environment) {
		builder.WriteString("  <env name=\"")
		builder.WriteString(xmlEscape(key))
		builder.WriteString("\" value=\"")
		builder.WriteString(xmlEscape(environment[key]))
		builder.WriteString("\"/>\n")
	}
	logPath := config.LogPath
	if logPath == "" {
		logPath = config.ConfigDir
	}
	writeWinSWElement(&builder, "logpath", logPath, 2)
	builder.WriteString("  <log mode=\"roll-by-size\">\n    <sizeThreshold>10240</sizeThreshold>\n    <keepFiles>4</keepFiles>\n  </log>\n")
	builder.WriteString("  <onfailure action=\"restart\" delay=\"5 sec\"/>\n  <stoptimeout>20 sec</stoptimeout>\n")
	builder.WriteString("  <serviceaccount>\n")
	domain := config.AccountDomain
	if domain == "" {
		domain = "."
	}
	writeWinSWElement(&builder, "domain", domain, 4)
	writeWinSWElement(&builder, "user", config.AccountUser, 4)
	builder.WriteString("    <allowservicelogon>true</allowservicelogon>\n  </serviceaccount>\n</service>\n")
	return builder.String(), nil
}

func writeWinSWElement(builder *strings.Builder, name, value string, indent int) {
	builder.WriteString(strings.Repeat(" ", indent))
	builder.WriteByte('<')
	builder.WriteString(name)
	builder.WriteByte('>')
	builder.WriteString(xmlEscape(value))
	builder.WriteString("</")
	builder.WriteString(name)
	builder.WriteString(">\n")
}

func SHA256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func EnsureWinSWBinary(ctx context.Context, client *http.Client, config WinSWConfig) (string, error) {
	executable := WinSWExecutablePath(config.ConfigDir)
	expected := strings.ToLower(strings.TrimSpace(config.ExpectedSHA256))
	if expected == "" {
		expected = WinSWSHA256
	}
	if data, err := os.ReadFile(executable); err == nil {
		if SHA256Hex(data) == expected {
			return executable, nil
		}
		if removeErr := os.Remove(executable); removeErr != nil {
			return "", fmt.Errorf("remove unverified WinSW binary: %w", removeErr)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if client == nil {
		client = http.DefaultClient
	}
	url := config.DownloadURL
	if url == "" {
		url = WinSWURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download WinSW %s: %w", WinSWVersion, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return "", fmt.Errorf("download WinSW %s: HTTP %d", WinSWVersion, response.StatusCode)
	}
	limit := config.DownloadMaxBytes
	if limit <= 0 || limit > maxWinSWBytes {
		limit = maxWinSWBytes
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return "", fmt.Errorf("read WinSW download: %w", err)
	}
	if int64(len(data)) > limit {
		return "", fmt.Errorf("WinSW download exceeds %d bytes", limit)
	}
	actual := SHA256Hex(data)
	if actual != expected {
		return "", fmt.Errorf("WinSW download failed SHA-256 verification (got %s, expected %s)", actual, expected)
	}
	if err := os.MkdirAll(filepath.Dir(executable), 0o700); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(filepath.Dir(executable), ".winsw-*.tmp")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o700); err == nil {
		_, err = temporary.Write(data)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, executable); err != nil {
		return "", err
	}
	return executable, nil
}

func validateWinSWXML(data string) error {
	decoder := xml.NewDecoder(strings.NewReader(data))
	for {
		_, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("invalid WinSW XML: %w", err)
		}
	}
}
