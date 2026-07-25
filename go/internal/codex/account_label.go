package codex

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
)

var CodexAccountLogLabelPattern = regexp.MustCompile(`^p[a-f0-9]{6}$`)

func CreateCodexAccountLogLabel(existingLabels ...string) string {
	used := make(map[string]struct{}, len(existingLabels))
	for _, label := range existingLabels {
		if label != "" {
			used[label] = struct{}{}
		}
	}
	for attempts := 0; attempts < 16; attempts++ {
		label := "p" + randomHex(3)
		if _, exists := used[label]; !exists {
			return label
		}
	}
	return "p" + randomHex(6)[:6]
}

func randomHex(bytes int) string {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(value)
}

func FallbackCodexAccountLogLabel(accountID string) string {
	digest := sha256.Sum256([]byte(accountID))
	return "p" + hex.EncodeToString(digest[:])[:6]
}

func CodexAccountLogLabel(account CodexAccount) string {
	if CodexAccountLogLabelPattern.MatchString(account.LogLabel) {
		return account.LogLabel
	}
	return FallbackCodexAccountLogLabel(account.ID)
}

func WithCodexAccountLogLabel(account CodexAccount, existing []CodexAccount) CodexAccount {
	if CodexAccountLogLabelPattern.MatchString(account.LogLabel) {
		return account
	}
	labels := make([]string, 0, len(existing))
	for _, candidate := range existing {
		labels = append(labels, candidate.LogLabel)
	}
	account.LogLabel = CreateCodexAccountLogLabel(labels...)
	return account
}
