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
