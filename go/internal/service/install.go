package service

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

func writeArtifact(path, content string, utf16LE bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data := []byte(content)
	if utf16LE {
		words := utf16.Encode([]rune(content))
		data = make([]byte, 2+len(words)*2)
		data[0], data[1] = 0xff, 0xfe
		for index, word := range words {
			binary.LittleEndian.PutUint16(data[2+index*2:], word)
		}
	}
	return os.WriteFile(path, data, 0o600)
}

func (m *launchdManager) Install() error {
	artifact, err := GenerateLaunchd(m.config)
	if err != nil {
		return err
	}
	if err := writeArtifact(m.ArtifactPath(), artifact, false); err != nil {
		return err
	}
	_, _ = run("launchctl", "unload", m.ArtifactPath())
	_, err = run("launchctl", "load", "-w", m.ArtifactPath())
	return err
}
func (m *launchdManager) Start() error {
	_, err := run("launchctl", "load", "-w", m.ArtifactPath())
	return err
}
func (m *launchdManager) Stop() error {
	_, err := run("launchctl", "unload", m.ArtifactPath())
	return ignoreAbsent(err)
}
func (m *launchdManager) Uninstall() error {
	_ = m.Stop()
	return ignoreAbsent(os.Remove(m.ArtifactPath()))
}
func (m *launchdManager) Status() (Status, error) {
	_, statErr := os.Stat(m.ArtifactPath())
	detail, err := run("launchctl", "list", LaunchdLabel)
	installed, running := statErr == nil, err == nil
	return Status{Installed: installed, Enabled: installed, Running: running, Viable: installed && running, Backend: "launchd", Detail: detail}, nil
}

func (m *systemdManager) Install() error {
	artifact, err := GenerateSystemd(m.config)
	if err != nil {
		return err
	}
	if err := writeArtifact(m.ArtifactPath(), artifact, false); err != nil {
		return err
	}
	if _, err := run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	_, err = run("systemctl", "--user", "enable", "--now", ServiceName+".service")
	return err
}
func (m *systemdManager) Start() error {
	_, err := run("systemctl", "--user", "start", ServiceName+".service")
	return err
}
func (m *systemdManager) Stop() error {
	_, err := run("systemctl", "--user", "stop", ServiceName+".service")
	return ignoreAbsent(err)
}
func (m *systemdManager) Uninstall() error {
	_, _ = run("systemctl", "--user", "disable", "--now", ServiceName+".service")
	err := ignoreAbsent(os.Remove(m.ArtifactPath()))
	_, _ = run("systemctl", "--user", "daemon-reload")
	return err
}
func (m *systemdManager) Status() (Status, error) {
	_, statErr := os.Stat(m.ArtifactPath())
	activeDetail, activeErr := run("systemctl", "--user", "is-active", ServiceName+".service")
	enabledDetail, enabledErr := run("systemctl", "--user", "is-enabled", ServiceName+".service")
	installed := statErr == nil
	running := activeErr == nil && strings.TrimSpace(activeDetail) == "active"
	enabled := enabledErr == nil && strings.TrimSpace(enabledDetail) == "enabled"
	return Status{Installed: installed, Enabled: enabled, Running: running, Viable: installed && enabled && running, Backend: "systemd", Detail: strings.TrimSpace(activeDetail + " " + enabledDetail)}, nil
}

func (m *taskManager) Install() error {
	artifact, err := GenerateTaskXML(m.config)
	if err != nil {
		return err
	}
	if err := writeArtifact(m.ArtifactPath(), artifact, true); err != nil {
		return err
	}
	launcher, err := GenerateTaskLauncher(m.config)
	if err != nil {
		return err
	}
	if err := writeArtifact(taskLauncherPath(m.config), launcher, false); err != nil {
		return err
	}
	if _, err := run("schtasks.exe", "/create", "/tn", ServiceName, "/xml", m.ArtifactPath(), "/f"); err != nil {
		return err
	}
	return m.Start()
}
func (m *taskManager) Start() error {
	_, err := run("schtasks.exe", "/run", "/tn", ServiceName)
	return err
}
func (m *taskManager) Stop() error {
	_, err := run("schtasks.exe", "/end", "/tn", ServiceName)
	return ignoreAbsent(err)
}
func (m *taskManager) Uninstall() error {
	_ = m.Stop()
	_, commandErr := run("schtasks.exe", "/delete", "/tn", ServiceName, "/f")
	fileErr := ignoreAbsent(os.Remove(m.ArtifactPath()))
	launcherErr := ignoreAbsent(os.Remove(taskLauncherPath(m.config)))
	return errors.Join(ignoreAbsent(commandErr), fileErr, launcherErr)
}
func (m *taskManager) Status() (Status, error) {
	xml, err := run("schtasks.exe", "/query", "/tn", ServiceName, "/xml")
	if err != nil {
		return Status{Backend: "scheduler", Detail: xml}, nil
	}
	state := ReadWindowsSchedulerXmlState(xml, `C:\Windows\System32\wscript.exe`, taskLauncherPath(m.config))
	detail, queryErr := run("schtasks.exe", "/query", "/tn", ServiceName, "/fo", "LIST", "/v")
	running := queryErr == nil && strings.Contains(strings.ToLower(detail), "running")
	viable := state.Installed && state.Enabled && state.RegistrationHealthy
	return Status{Installed: state.Installed, Enabled: state.Enabled, Running: running, Viable: viable, Stale: state.Installed && !state.RegistrationHealthy, Backend: "scheduler", Detail: detail}, nil
}

func ignoreAbsent(err error) error {
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "not found") || strings.Contains(message, "does not exist") || strings.Contains(message, "cannot find") {
		return nil
	}
	return fmt.Errorf("service lifecycle: %w", err)
}
