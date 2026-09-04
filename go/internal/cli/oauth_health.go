package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

const maskedAccountFallback = "account-…????"

type oauthHealthInput struct {
	NeedsReauth    bool
	ReauthReason   string
	CooldownUntil  time.Time
	CooldownReason string
	WarningReason  string
	Now            time.Time
}

type oauthHealthEntry struct {
	Provider  string                        `json:"provider"`
	AccountID string                        `json:"accountId"`
	Health    management.OAuthAccountHealth `json:"health"`
	Action    string                        `json:"action,omitempty"`
}

type oauthCLIHealthReport struct {
	Entries           []oauthHealthEntry `json:"entries"`
	CodexHealthSource string             `json:"codexHealthSource"`
}

func projectOAuthAccountHealth(input oauthHealthInput) management.OAuthAccountHealth {
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	if input.NeedsReauth {
		reason := input.ReauthReason
		if reason == "" {
			reason = "refresh_failed"
		}
		return management.OAuthAccountHealth{Status: "reauth_required", Reason: reason}
	}
	if input.CooldownUntil.After(now) {
		reason := input.CooldownReason
		if reason == "" {
			reason = "quota"
		}
		return management.OAuthAccountHealth{Status: "cooldown", Until: input.CooldownUntil.UTC().Format("2006-01-02T15:04:05.000Z"), Reason: reason}
	}
	if input.WarningReason != "" {
		return management.OAuthAccountHealth{Status: "warning", Reason: input.WarningReason}
	}
	return management.OAuthAccountHealth{Status: "healthy"}
}

func projectStoredOAuthAccountHealth(provider string, account oauth.ProviderAccount, store *oauth.CredentialStore, now time.Time) management.OAuthAccountHealth {
	warning := ""
	if intent, ok := store.ReadRefreshIntent(provider, account.ID); ok && intent.Uncertain {
		warning = "refresh_conflict"
	} else if account.Credential.Access == "" || account.Credential.Refresh == "" && !(provider == "kiro" && account.Credential.Expires > now.UnixMilli()) {
		warning = "stale_credentials"
	}
	return projectOAuthAccountHealth(oauthHealthInput{NeedsReauth: account.NeedsReauth, ReauthReason: "refresh_failed", WarningReason: warning, Now: now})
}

func oauthAccountHealthFields(provider, accountID string, health management.OAuthAccountHealth) (label, summary, action string) {
	switch health.Status {
	case "healthy":
		label = "Healthy"
	case "cooldown":
		if health.Reason == "rate_limit" {
			label = "Rate limited"
		} else {
			label = "Quota limited"
		}
		action = "wait until " + health.Until + " or start a new session with another eligible account"
	case "reauth_required":
		if health.Reason == "refresh_failed" {
			label = "Refresh failed"
		} else {
			label = "Reauthentication required"
		}
		if provider == "codex" {
			action = "reauthenticate via the dashboard Codex account pool"
		} else {
			action = fmt.Sprintf("run `ocx login %s`", provider)
		}
	case "warning":
		switch health.Reason {
		case "refresh_conflict":
			label = "Credential conflict"
			action = "re-run `ocx doctor` after ensuring only one proxy process writes the credential store"
		case "metadata_mismatch":
			label = "Metadata mismatch"
		case "stale_credentials":
			label = "Refresh failed"
		}
	}
	masked := ocxlib.MaskAccountID(accountID)
	if accountID == codex.MainCodexAccountID {
		masked = "main account"
	}
	if masked == "" {
		masked = maskedAccountFallback
	}
	switch health.Status {
	case "healthy":
		summary = fmt.Sprintf("%s %s: healthy", provider, masked)
	case "cooldown":
		why := "quota limited"
		if health.Reason == "rate_limit" {
			why = "rate limited"
		}
		summary = fmt.Sprintf("%s %s: %s until %s. Routing for this account is paused until then.", provider, masked, why, health.Until)
	case "reauth_required":
		summary = fmt.Sprintf("%s %s: reauthentication required (%s).", provider, masked, strings.ReplaceAll(health.Reason, "_", " "))
	case "warning":
		summary = fmt.Sprintf("%s %s: %s.", provider, masked, strings.ReplaceAll(health.Reason, "_", " "))
	}
	if action != "" && health.Status != "healthy" {
		summary += " Next: " + action
	}
	return label, summary, action
}

func applyOAuthHealthFields(account *management.OAuthAccount, provider string, stored oauth.ProviderAccount, store *oauth.CredentialStore, now time.Time) {
	health := projectStoredOAuthAccountHealth(provider, stored, store, now)
	label, summary, action := oauthAccountHealthFields(provider, account.ID, health)
	account.Health, account.HealthLabel, account.HealthSummary, account.HealthAction = health, label, summary, action
}
