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
	normalized, normalizeErr := NormalizeConcreteVersion(result.LatestVersion)
	if normalizeErr != nil {
		result.LatestVersion = ""
		result.Reason = "latest_unavailable"
		return result
	}
	result.LatestVersion = normalized
	newer, transitionErr := ValidateNativeTransition(c.CurrentVersion, result.LatestVersion, channel)
	if transitionErr != nil {
		result.LatestVersion = ""
		result.Reason = "latest_unavailable"
		return result
	}
	result.UpdateAvailable = newer
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

// ValidateNativeTransition validates only concrete registry output. The
// TypeScript updater installs the resolved registry version whenever it differs
// from the current version; it does not impose a native-only same-major,
// preview, downgrade, or strictly-newer policy. The native line must therefore
// fail closed on malformed values while preserving the source update decision.
func ValidateNativeTransition(current, latest string, channel Channel) (bool, error) {
	if err := ValidateChannel(channel); err != nil {
		return false, err
	}
	current = strings.TrimPrefix(strings.TrimSpace(current), "v")
	latest = strings.TrimPrefix(strings.TrimSpace(latest), "v")
	if _, ok := parseConcreteVersion(latest); !ok {
		return false, fmt.Errorf("release version %q does not match %s channel", latest, channel)
	}
	return latest != current, nil
}

func parseConcreteVersion(value string) (string, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if stable, ok := parseStable(value); ok {
		return fmt.Sprintf("%d.%d.%d", stable[0], stable[1], stable[2]), true
	}
	if preview, ok := parsePreview(value); ok {
		return fmt.Sprintf("%d.%d.%d-preview.%d", preview[0], preview[1], preview[2], preview[3]), true
	}
	return "", false
}

func NormalizeConcreteVersion(value string) (string, error) {
	if normalized, ok := parseConcreteVersion(value); ok {
		return normalized, nil
	}
	return "", fmt.Errorf("release version %q is not concrete", strings.TrimSpace(value))
}
