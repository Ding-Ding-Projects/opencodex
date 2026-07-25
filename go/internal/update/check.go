package update

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

const ReleaseNotesURL = "https://github.com/lidge-jun/opencodex/releases/latest"

type Channel string

const (
	ChannelLatest  Channel = "latest"
	ChannelPreview Channel = "preview"
)

type Installer string

const (
	InstallerBun    Installer = "bun"
	InstallerNPM    Installer = "npm"
	InstallerSource Installer = "source"
)

type CheckResult struct {
	CurrentVersion  string
	LatestVersion   string
	Channel         Channel
	Installer       Installer
	UpdateAvailable bool
	CanUpdate       bool
	Command         string
	ReleaseNotesURL string
	Reason          string
}

type LatestVersionFunc func(context.Context, Channel) (string, error)

type Checker struct {
	CurrentVersion string
	Installer      Installer
	LatestVersion  LatestVersionFunc
}

func DefaultChannel(current string) Channel {
	if strings.Contains(current, "-preview.") {
		return ChannelPreview
	}
	return ChannelLatest
}

func NormalizeChannel(requested Channel, current string) Channel {
	if requested == ChannelLatest || requested == ChannelPreview {
		return requested
	}
	return DefaultChannel(current)
}

func (c Checker) Check(ctx context.Context, requested Channel) CheckResult {
	channel := NormalizeChannel(requested, c.CurrentVersion)
	result := CheckResult{
		CurrentVersion:  c.CurrentVersion,
		Channel:         channel,
		Installer:       c.Installer,
		Command:         InstallCommand(c.Installer, channel, "").String(),
		ReleaseNotesURL: ReleaseNotesURL,
	}
	if c.Installer == InstallerSource {
		result.Command = ManualSourceCommand()
		result.Reason = "source_checkout"
		return result
	}
	if c.LatestVersion == nil {
		result.Reason = "latest_unavailable"
		return result
	}
	latest, err := c.LatestVersion(ctx, channel)
	if err != nil || strings.TrimSpace(latest) == "" {
		result.Reason = "latest_unavailable"
		return result
	}
	result.LatestVersion = strings.TrimSpace(latest)
	result.UpdateAvailable = IsNewer(result.LatestVersion, c.CurrentVersion, channel)
	result.CanUpdate = result.UpdateAvailable
	result.Command = InstallCommand(c.Installer, channel, result.LatestVersion).String()
	if !result.UpdateAvailable {
		result.Reason = "already_latest"
	}
	return result
}

func IsNewer(latest, current string, channel Channel) bool {
	if channel == ChannelLatest {
		left, leftOK := parseStable(latest)
		right, rightOK := parseStable(current)
		return leftOK && rightOK && greater(left, right)
	}
	leftPreview, leftPreviewOK := parsePreview(latest)
	rightPreview, rightPreviewOK := parsePreview(current)
	if leftPreviewOK && rightPreviewOK {
		return greater(leftPreview, rightPreview)
	}
	leftStable, leftStableOK := parseStable(latest)
	if leftStableOK && rightPreviewOK {
		return greater(leftStable, rightPreview[:3])
	}
	rightStable, rightStableOK := parseStable(current)
	return leftStableOK && rightStableOK && greater(leftStable, rightStable)
}

func parseStable(value string) ([]int, bool) {
	return parseNumericVersion(value, 3, "")
}

func parsePreview(value string) ([]int, bool) {
	return parseNumericVersion(value, 4, "-preview.")
}

func parseNumericVersion(value string, count int, separator string) ([]int, bool) {
	value = strings.TrimSpace(value)
	if separator != "" {
		value = strings.Replace(value, separator, ".", 1)
	} else if strings.Contains(value, "-") {
		return nil, false
	}
	parts := strings.Split(value, ".")
	if len(parts) != count {
		return nil, false
	}
	numbers := make([]int, count)
	for i, part := range parts {
		if part == "" || strings.Trim(part, "0123456789") != "" {
			return nil, false
		}
		number, err := strconv.Atoi(part)
		if err != nil {
			return nil, false
		}
		numbers[i] = number
	}
	return numbers, true
}

func greater(left, right []int) bool {
	for i := range left {
		if left[i] != right[i] {
			return left[i] > right[i]
		}
	}
	return false
}

func ValidateChannel(channel Channel) error {
	if channel != ChannelLatest && channel != ChannelPreview {
		return fmt.Errorf("unsupported update channel %q", channel)
	}
	return nil
}
