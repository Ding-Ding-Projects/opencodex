package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

const accountUsage = `Usage:
  ocx account list [provider] [--json] [--all]
  ocx account current <provider> [--json]
  ocx account use <provider> <account-id> [--json]
  ocx account refresh <provider> [account-id] [--json]
  ocx account auto-switch openai <on|off|status|threshold 0-100> [--json]
  ocx account add <provider> [--json-stdin]
  ocx account remove <provider> <account-id> --yes [--json]`

func accountStore() (*oauth.CredentialStore, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	return oauth.NewCredentialStore(filepath.Join(dir, "auth.json")), nil
}

func runAccount(ctx context.Context, args []string, streams IO) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprintln(streams.Out, accountUsage)
		return err
	}
	store, err := accountStore()
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		return accountList(store, args[1:], streams)
	case "current":
		return accountCurrent(store, args[1:], streams)
	case "switch", "use":
		return accountUse(ctx, store, args[1:], streams)
	case "add":
		return accountAdd(ctx, store, args[1:], streams)
	case "remove":
		return accountRemove(ctx, store, args[1:], streams)
	case "refresh":
		return accountRefresh(ctx, store, args[1:], streams)
	case "auto-switch":
		return accountAutoSwitch(args[1:], streams)
	default:
		return fmt.Errorf("unknown account subcommand %q\n%s", args[0], accountUsage)
	}
}

type accountRow struct {
	Provider    string `json:"provider"`
	ID          string `json:"id"`
	Alias       string `json:"alias,omitempty"`
	Email       string `json:"email,omitempty"`
	Active      bool   `json:"active"`
	NeedsReauth bool   `json:"needsReauth,omitempty"`
	ExpiresAt   int64  `json:"expiresAt,omitempty"`
	Source      string `json:"source,omitempty"`
}

func accountList(store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	showAll, rest := consumeBoolFlag(rest, "--all")
	if len(rest) > 1 {
		return fmt.Errorf("usage: ocx account list [provider] [--json] [--all]")
	}
	filter := ""
	if len(rest) == 1 {
		filter = normalizeAccountProvider(rest[0])
	}
	auth, err := store.Load()
	if err != nil {
		return err
	}
	providers := make([]string, 0, len(auth))
	for provider := range auth {
		if filter == "" || provider == filter {
			providers = append(providers, provider)
		}
	}
	sort.Strings(providers)
	rows := []accountRow{}
	for _, provider := range providers {
		set := auth[provider]
		for _, account := range set.Accounts {
			rows = append(rows, accountRowFromCredential(provider, set.ActiveAccountID, account))
		}
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"accounts": rows})
	}
	if len(rows) == 0 {
		if showAll && filter != "" {
			fmt.Fprintf(streams.Out, "%s: no stored accounts\n", filter)
		} else {
			fmt.Fprintln(streams.Out, "No stored OAuth accounts.")
		}
		return nil
	}
	printAccountRows(streams.Out, rows)
	return nil
}

func accountCurrent(store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 {
		return fmt.Errorf("usage: ocx account current <provider> [--json]")
	}
	provider := normalizeAccountProvider(rest[0])
	set, ok, err := store.GetAccountSet(provider)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no accounts for %s", provider)
	}
	for _, account := range set.Accounts {
		if account.ID != set.ActiveAccountID {
			continue
		}
		row := accountRowFromCredential(provider, set.ActiveAccountID, account)
		if jsonOutput {
			return writePrettyJSON(streams.Out, map[string]any{"provider": provider, "activeId": set.ActiveAccountID, "account": row})
		}
		printAccountRows(streams.Out, []accountRow{row})
		return nil
	}
	return fmt.Errorf("active account %q was not found for %s", set.ActiveAccountID, provider)
}

func accountUse(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 2 {
		return fmt.Errorf("usage: ocx account use <provider> <account-id> [--json]")
	}
	provider := normalizeAccountProvider(rest[0])
	changed, err := store.SetActiveAccount(ctx, provider, rest[1])
	if err != nil {
		return err
	}
	if !changed {
		return fmt.Errorf("account %q was not found for %s", rest[1], provider)
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "provider": provider, "activeId": rest[1]})
	}
	fmt.Fprintf(streams.Out, "Active %s account: %s\n", provider, rest[1])
	return nil
}

func accountRemove(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	confirmed, rest := consumeBoolFlag(rest, "--yes")
	if len(rest) != 2 {
		return fmt.Errorf("usage: ocx account remove <provider> <account-id> --yes [--json]")
	}
	if !confirmed {
		return fmt.Errorf("confirmation required; re-run with --yes")
	}
	provider := normalizeAccountProvider(rest[0])
	removed, err := store.RemoveAccount(ctx, provider, rest[1])
	if err != nil {
		return err
	}
	if !removed {
		return fmt.Errorf("account %q was not found for %s", rest[1], provider)
	}
	set, remaining, err := accountSetSummary(store, provider)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"ok": true, "provider": provider, "id": rest[1], "remaining": remaining, "activeId": nullableString(set.ActiveAccountID)})
	}
	if remaining == 0 {
		fmt.Fprintf(streams.Out, "%s: no accounts remaining\n", provider)
	} else {
		fmt.Fprintf(streams.Out, "%s: active account is now %s\n", provider, set.ActiveAccountID)
	}
	return nil
}

func accountAdd(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	options, err := parseAccountAdd(args)
	if err != nil {
		return err
	}
	provider := normalizeAccountProvider(options.Provider)
	credential := oauth.OAuthCredentials{Access: options.Access, Refresh: options.Refresh, Expires: options.Expires, Source: oauth.SourceManual}
	if options.JSONStdin {
		decoder := json.NewDecoder(io.LimitReader(streams.In, 1<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&credential); err != nil {
			return fmt.Errorf("decode credential JSON: %w", err)
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return fmt.Errorf("credential input must contain one JSON value")
		}
	}
	if credential.Access == "" {
		credential.Access = strings.TrimSpace(os.Getenv("OCX_ACCOUNT_ACCESS_TOKEN"))
	}
	if credential.Access == "" {
		return fmt.Errorf("access token is required; prefer --json-stdin or OCX_ACCOUNT_ACCESS_TOKEN")
	}
	if strings.ContainsAny(credential.Access+credential.Refresh, "\r\n") {
		return fmt.Errorf("tokens must not contain line breaks")
	}
	if err := store.SaveCredential(ctx, provider, credential); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Added %s credential.\n", provider)
	return nil
}

type accountAddOptions struct {
	Provider, Access, Refresh string
	Expires                   int64
	JSONStdin                 bool
}

func parseAccountAdd(args []string) (accountAddOptions, error) {
	options := accountAddOptions{Expires: time.Now().Add(time.Hour).UnixMilli()}
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--json-stdin":
			options.JSONStdin = true
		case "--access-token", "--refresh-token", "--expires":
			flag := args[index]
			if index+1 >= len(args) {
				return options, fmt.Errorf("%s requires a value", flag)
			}
			index++
			switch flag {
			case "--access-token":
				options.Access = args[index]
			case "--refresh-token":
				options.Refresh = args[index]
			case "--expires":
				value, err := strconv.ParseInt(args[index], 10, 64)
				if err != nil || value <= 0 {
					return options, fmt.Errorf("--expires must be epoch milliseconds")
				}
				options.Expires = value
			}
		default:
			if strings.HasPrefix(args[index], "-") {
				return options, fmt.Errorf("unknown account add flag %q", args[index])
			}
			if options.Provider != "" {
				return options, fmt.Errorf("unexpected account add argument %q", args[index])
			}
			options.Provider = args[index]
		}
	}
	if options.Provider == "" {
		return options, fmt.Errorf("usage: ocx account add <provider> [--json-stdin]")
	}
	return options, nil
}

func accountRefresh(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) != 1 && len(rest) != 2 {
		return fmt.Errorf("usage: ocx account refresh <provider> [account-id] [--json]")
	}
	provider := normalizeAccountProvider(rest[0])
	set, ok, err := store.GetAccountSet(provider)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no accounts for %s", provider)
	}
	accountID := set.ActiveAccountID
	if len(rest) == 2 {
		accountID = rest[1]
	}
	credential, ok, err := store.GetAccountCredential(provider, accountID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("account %q was not found", accountID)
	}
	flowName, _ := normalizeLoginProvider(provider)
	flow, flowErr := newLoginFlow(flowName, nil, strings.TrimSpace(os.Getenv("KIRO_CREDENTIALS_FILE")))
	refreshFlow, refreshable := flow.(refreshableLoginFlow)
	if flowErr == nil && refreshable && credential.Refresh != "" {
		result, refreshErr := store.RefreshAccount(ctx, provider, accountID, refreshFlow.Refresh)
		if refreshErr != nil {
			return refreshErr
		}
		return printRefreshResult(streams, provider, accountID, result.Credential, true, jsonOutput)
	}
	if credential.Expired(time.Now(), time.Minute) {
		if flowErr != nil {
			return fmt.Errorf("account %s requires provider reauthentication: %w", accountID, flowErr)
		}
		return fmt.Errorf("account %s requires provider reauthentication", accountID)
	}
	return printRefreshResult(streams, provider, accountID, credential, false, jsonOutput)
}

func printRefreshResult(streams IO, provider, accountID string, credential oauth.OAuthCredentials, refreshed, jsonOutput bool) error {
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"provider": provider, "accountId": accountID, "refreshed": refreshed, "expiresAt": credential.Expires, "needsReauth": false})
	}
	action := "valid"
	if refreshed {
		action = "refreshed"
	}
	fmt.Fprintf(streams.Out, "Account %s is %s until %s.\n", accountID, action, time.UnixMilli(credential.Expires).Format(time.RFC3339))
	return nil
}

func accountRowFromCredential(provider, active string, account oauth.ProviderAccount) accountRow {
	return accountRow{Provider: provider, ID: account.ID, Alias: account.Alias, Email: account.Credential.Email, Active: account.ID == active, NeedsReauth: account.NeedsReauth, ExpiresAt: account.Credential.Expires, Source: string(account.Credential.Source)}
}

func printAccountRows(writer io.Writer, rows []accountRow) {
	fmt.Fprintln(writer, "PROVIDER            ID            IDENTITY                  STATUS")
	for _, row := range rows {
		identity := row.Alias
		if identity == "" {
			identity = row.Email
		}
		if identity == "" {
			identity = "-"
		}
		status := ""
		if row.Active {
			status = "active"
		}
		if row.NeedsReauth {
			status = strings.TrimSpace(status + " needs-reauth")
		}
		fmt.Fprintf(writer, "%-19s %-13s %-25s %s\n", row.Provider, row.ID, identity, status)
	}
}

func accountSetSummary(store *oauth.CredentialStore, provider string) (oauth.ProviderAccountSet, int, error) {
	set, ok, err := store.GetAccountSet(provider)
	if err != nil || !ok {
		return oauth.ProviderAccountSet{}, 0, err
	}
	return set, len(set.Accounts), nil
}

func normalizeAccountProvider(provider string) string {
	_, store := normalizeLoginProvider(provider)
	return store
}
