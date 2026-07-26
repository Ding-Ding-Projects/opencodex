package update

import (
	"context"
	"testing"
)

func TestIsNewerChannelSemantics(t *testing.T) {
	tests := []struct {
		latest, current string
		channel         Channel
		want            bool
	}{
		{"2.8.0", "2.7.9", ChannelLatest, true},
		{"2.8.0-preview.1", "2.7.9", ChannelLatest, false},
		{"2.8.0-preview.2", "2.8.0-preview.1", ChannelPreview, true},
		{"2.8.0", "2.8.0-preview.9", ChannelPreview, false},
		{"2.9.0", "2.8.0-preview.9", ChannelPreview, true},
	}
	for _, test := range tests {
		if got := IsNewer(test.latest, test.current, test.channel); got != test.want {
			t.Errorf("IsNewer(%q, %q, %q) = %v, want %v", test.latest, test.current, test.channel, got, test.want)
		}
	}
}

func TestChecker(t *testing.T) {
	checker := Checker{CurrentVersion: "2.7.0", Installer: InstallerNPM, LatestVersion: func(context.Context, Channel) (string, error) { return "2.8.0", nil }}
	result := checker.Check(context.Background(), ChannelLatest)
	if !result.CanUpdate || result.LatestVersion != "2.8.0" || result.Reason != "" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestValidateNativeTransition(t *testing.T) {
	tests := []struct {
		name            string
		current, latest string
		channel         Channel
		wantNewer       bool
		wantError       bool
	}{
		{"stable newer", "2.7.0", "2.8.0", ChannelLatest, true, false},
		{"preview newer", "2.7.0-preview.1", "2.7.0-preview.2", ChannelPreview, true, false},
		{"equal", "2.7.0", "2.7.0", ChannelLatest, false, false},
		{"downgrade", "2.8.0", "2.7.9", ChannelLatest, false, true},
		{"stable to preview", "2.7.0", "2.8.0-preview.1", ChannelLatest, false, true},
		{"preview to stable", "2.7.0-preview.1", "2.8.0", ChannelPreview, false, true},
		{"cross major", "2.7.0", "3.0.0", ChannelLatest, false, true},
		{"malformed current", "dev", "2.8.0", ChannelLatest, false, true},
		{"malformed latest", "2.7.0", "wat", ChannelLatest, false, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			newer, err := ValidateNativeTransition(test.current, test.latest, test.channel)
			if newer != test.wantNewer || (err != nil) != test.wantError {
				t.Fatalf("newer=%t err=%v", newer, err)
			}
		})
	}
}
