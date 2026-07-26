package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

const codexHealthUnavailableNote = "Codex health: unavailable (proxy not running; live cooldown/reauth requires the management API)"

type oauthHealthCollectOptions struct {
	AuthPath   string
	BaseURL    string
	Token      string
	HTTPClient *http.Client
	ReadFile   func(string) ([]byte, error)
	Now        time.Time
}

func collectOAuthCLIHealth(ctx context.Context, options oauthHealthCollectOptions) oauthCLIHealthReport {
	if options.ReadFile == nil {
		options.ReadFile = os.ReadFile
	}
	if options.HTTPClient == nil {
		options.HTTPClient = http.DefaultClient
	}
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	report := oauthCLIHealthReport{Entries: collectStoredOAuthHealth(options.AuthPath, options.ReadFile, options.Now), CodexHealthSource: "unavailable"}
	if strings.TrimSpace(options.BaseURL) == "" {
		return report
	}
	requestCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, strings.TrimRight(options.BaseURL, "/")+"/api/codex-auth/accounts", nil)
	if err != nil {
		return report
	}
	if options.Token != "" {
		request.Header.Set("X-OpenCodex-API-Key", options.Token)
	}
	response, err := options.HTTPClient.Do(request)
	if err != nil {
		return report
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return report
	}
	var payload struct {
		Accounts []struct {
			ID          string                        `json:"id"`
			NeedsReauth bool                          `json:"needsReauth"`
			Health      management.OAuthAccountHealth `json:"health"`
		} `json:"accounts"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload) != nil {
		return report
	}
	for _, account := range payload.Accounts {
		if strings.TrimSpace(account.ID) == "" {
			continue
		}
		health := account.Health
		if !knownOAuthHealthStatus(health.Status) {
			health = projectOAuthAccountHealth(oauthHealthInput{NeedsReauth: account.NeedsReauth, Now: options.Now})
		}
		_, _, action := oauthAccountHealthFields("codex", account.ID, health)
		report.Entries = append(report.Entries, oauthHealthEntry{Provider: "codex", AccountID: account.ID, Health: health, Action: action})
	}
	report.CodexHealthSource = "management-api"
	return report
}

func collectStoredOAuthHealth(path string, readFile func(string) ([]byte, error), now time.Time) []oauthHealthEntry {
	data, err := readFile(path)
	if err != nil || len(data) > 8<<20 {
		return nil
	}
	var storeValue oauth.AuthStore
	if json.Unmarshal(data, &storeValue) != nil {
		return nil
	}
	store := oauth.NewCredentialStore(path)
	entries := make([]oauthHealthEntry, 0)
	for provider, set := range storeValue {
		if provider == "openai" {
			continue // Go stores Codex pool credentials here; live health comes from management API.
		}
		for _, account := range set.Accounts {
			health := projectStoredOAuthAccountHealth(provider, account, store, now)
			_, _, action := oauthAccountHealthFields(provider, account.ID, health)
			entries = append(entries, oauthHealthEntry{Provider: provider, AccountID: account.ID, Health: health, Action: action})
		}
	}
	return entries
}

func knownOAuthHealthStatus(status string) bool {
	switch status {
	case "healthy", "cooldown", "reauth_required", "warning":
		return true
	default:
		return false
	}
}

func formatOAuthHealthForStatus(report oauthCLIHealthReport) string {
	parts := make([]string, 0, 2)
	if report.CodexHealthSource == "unavailable" {
		parts = append(parts, codexHealthUnavailableNote)
	}
	notable := make([]oauthHealthEntry, 0, len(report.Entries))
	for _, entry := range report.Entries {
		if entry.Health.Status != "healthy" {
			notable = append(notable, entry)
		}
	}
	if len(report.Entries) > 0 && len(notable) == 0 {
		parts = append(parts, "OAuth health: ok")
	} else if len(notable) > 0 {
		lines := []string{"OAuth health: warning"}
		for _, entry := range notable {
			masked := ocxlib.MaskAccountID(entry.AccountID)
			if masked == "" {
				masked = maskedAccountFallback
			}
			lines = append(lines, fmt.Sprintf("  %s  %s  %s", entry.Provider, masked, describeOAuthHealth(entry)))
			if entry.Action != "" {
				lines = append(lines, "    Action: "+entry.Action)
			}
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return strings.Join(parts, "\n")
}

func describeOAuthHealth(entry oauthHealthEntry) string {
	switch entry.Health.Status {
	case "healthy":
		return "healthy"
	case "reauth_required":
		return "reauthentication required"
	case "cooldown":
		if entry.Health.Reason == "rate_limit" {
			return "rate limited until " + entry.Health.Until
		}
		return "quota limited until " + entry.Health.Until
	case "warning":
		return strings.ReplaceAll(entry.Health.Reason, "_", " ")
	default:
		return "unknown"
	}
}
