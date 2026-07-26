package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

var publicOAuthProviders = []string{
	"xai", "anthropic", "kimi", "kiro", "google-antigravity", "cursor", "github-copilot",
}

type loginFlow interface {
	Login(context.Context, func(oauth.Authorization)) (oauth.OAuthCredentials, error)
}

type refreshableLoginFlow interface {
	loginFlow
	Refresh(context.Context, string) (oauth.OAuthCredentials, error)
}

type browserLoginFlow struct {
	flow   oauth.BrowserFlow
	manual oauth.ManualCodeFunc
}

type anthropicLoginFlow struct {
	browser browserLoginFlow
}

func (f anthropicLoginFlow) Login(ctx context.Context, onAuth func(oauth.Authorization)) (oauth.OAuthCredentials, error) {
	if local, ok := oauth.DetectClaudeCodeToken(""); ok {
		if onAuth != nil {
			onAuth(oauth.Authorization{Instructions: "Found Claude Code credentials; importing automatically."})
		}
		if local.Expires >= time.Now().Add(time.Minute).UnixMilli() {
			return local, nil
		}
		if refreshed, err := f.browser.Refresh(ctx, local.Refresh); err == nil {
			refreshed.Source = oauth.SourceLocalCLI
			return refreshed, nil
		}
	}
	return f.browser.Login(ctx, onAuth)
}

func (f browserLoginFlow) Login(ctx context.Context, onAuth func(oauth.Authorization)) (oauth.OAuthCredentials, error) {
	return oauth.RunBrowserLogin(ctx, f.flow, onAuth, f.manual)
}

func (f browserLoginFlow) Refresh(ctx context.Context, refresh string) (oauth.OAuthCredentials, error) {
	return f.flow.Refresh(ctx, refresh)
}

type kiroImportFlow struct {
	flow *oauth.KiroFlow
	path string
}

func (f kiroImportFlow) Login(_ context.Context, onAuth func(oauth.Authorization)) (oauth.OAuthCredentials, error) {
	credential, found, err := f.flow.Import(f.path)
	if err != nil {
		return oauth.OAuthCredentials{}, fmt.Errorf("import Kiro credential: %w", err)
	}
	if !found {
		return oauth.OAuthCredentials{}, fmt.Errorf("no Kiro credential found; install the Kiro CLI (`curl -fsSL https://cli.kiro.dev/install | bash`) and run `kiro-cli login`, or set KIRO_ACCESS_TOKEN")
	}
	if onAuth != nil {
		onAuth(oauth.Authorization{Instructions: "Imported an existing Kiro CLI credential."})
	}
	return credential.OAuthCredentials, nil
}

func newLoginFlow(provider string, client oauth.HTTPDoer, kiroPath string) (loginFlow, error) {
	switch provider {
	case "chatgpt":
		return browserLoginFlow{flow: oauth.NewChatGPTFlow(client)}, nil
	case "anthropic":
		return anthropicLoginFlow{browser: browserLoginFlow{flow: oauth.NewAnthropicFlow(client)}}, nil
	case "xai":
		return browserLoginFlow{flow: oauth.NewXAIFlow(client)}, nil
	case "google-antigravity":
		return browserLoginFlow{flow: oauth.NewAntigravityFlow(client)}, nil
	case "cursor":
		return oauth.NewCursorFlow(client), nil
	case "kimi":
		return oauth.NewKimiFlow(client), nil
	case "github-copilot":
		return oauth.NewGithubCopilotFlow(client), nil
	case "kiro":
		return kiroImportFlow{flow: oauth.NewKiroFlow(client), path: kiroPath}, nil
	default:
		return nil, fmt.Errorf("unsupported OAuth provider %q; choose %s", provider, strings.Join(publicOAuthProviders, ", "))
	}
}

func normalizeLoginProvider(value string) (flowName, storeName string) {
	name := strings.ToLower(strings.TrimSpace(value))
	if name == "openai" || name == "chatgpt" {
		return "chatgpt", "openai"
	}
	return name, name
}

func runLogin(ctx context.Context, args []string, streams IO) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: ocx login <provider>\nOAuth providers: %s", strings.Join(publicOAuthProviders, ", "))
	}
	flowName, storeName := normalizeLoginProvider(args[0])
	flow, err := newLoginFlow(flowName, nil, "")
	if err != nil {
		return err
	}
	if browser, ok := flow.(browserLoginFlow); ok {
		browser.manual = manualCodeInput(streams)
		flow = browser
	} else if anthropic, ok := flow.(anthropicLoginFlow); ok {
		anthropic.browser.manual = manualCodeInput(streams)
		flow = anthropic
	}
	onAuth := func(auth oauth.Authorization) {
		fmt.Fprintf(streams.Out, "\nAuthentication for %s\n", storeName)
		if auth.URL != "" {
			fmt.Fprintln(streams.Out, auth.URL)
		}
		if auth.Instructions != "" {
			fmt.Fprintln(streams.Out, auth.Instructions)
		}
		if auth.URL != "" {
			if openErr := platform.OpenURL(auth.URL); openErr != nil {
				fmt.Fprintf(streams.Err, "Warning: could not open browser: %v\n", openErr)
			}
		}
	}
	credential, err := flow.Login(ctx, onAuth)
	if err != nil {
		return err
	}
	store, err := accountStore()
	if err != nil {
		return err
	}
	if err := store.SaveCredential(ctx, storeName, credential); err != nil {
		return err
	}
	if storeName != "openai" {
		if err := upsertOAuthProviderConfig(storeName); err != nil {
			return fmt.Errorf("credential saved, but provider config update failed: %w", err)
		}
	}
	fmt.Fprintf(streams.Out, "\nLogged in to %s.\n", storeName)
	return nil
}

func manualCodeInput(streams IO) oauth.ManualCodeFunc {
	if streams.In == nil {
		return nil
	}
	if file, ok := streams.In.(*os.File); ok {
		info, err := file.Stat()
		if err != nil || info.Mode()&os.ModeCharDevice == 0 {
			return nil
		}
	}
	reader := bufio.NewReader(io.LimitReader(streams.In, 16<<10))
	return func(ctx context.Context, _ string) (string, error) {
		fmt.Fprint(streams.Out, "Paste redirect URL or authorization code (or wait for browser): ")
		result := make(chan struct {
			value string
			err   error
		}, 1)
		go func() {
			value, err := reader.ReadString('\n')
			if err == io.EOF && strings.TrimSpace(value) != "" {
				err = nil
			}
			result <- struct {
				value string
				err   error
			}{strings.TrimSpace(value), err}
		}()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case result := <-result:
			return result.value, result.err
		}
	}
}

func upsertOAuthProviderConfig(provider string) error {
	seed, ok := providers.DeriveOAuthProviderConfig(provider)
	if !ok {
		return fmt.Errorf("OAuth provider %q is missing from the registry", provider)
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	cfg.Providers[provider] = configProviderFromSeed(seed)
	return config.Save(path, cfg)
}

func configProviderFromSeed(seed providers.ProviderConfig) config.ProviderConfig {
	liveModels := seed.LiveModels
	return config.ProviderConfig{
		Adapter: seed.Adapter, BaseURL: seed.BaseURL, APIKey: seed.APIKey,
		AuthMode: seed.AuthMode, CodexAccountMode: seed.CodexAccountMode,
		DefaultModel: seed.DefaultModel, Models: append([]string(nil), seed.Models...),
		Headers: cloneStringMap(seed.Headers), GoogleMode: seed.GoogleMode,
		Project: seed.Project, Location: seed.Location, ContextWindow: seed.ContextWindow,
		DefaultMaxOutputTokens: seed.DefaultMaxOutputTokens, ParallelToolCalls: seed.ParallelToolCalls,
		EscapeBuiltinToolNames: optionalTrue(seed.EscapeBuiltinToolNames), KeyOptional: optionalTrue(seed.KeyOptional),
		ModelSuffixBracketStrip:        optionalTrue(seed.ModelSuffixBracketStrip),
		ReasoningEfforts:               append([]string(nil), seed.ReasoningEfforts...),
		ModelReasoningEfforts:          cloneStringSlices(seed.ModelReasoningEfforts),
		ModelDefaultReasoningEfforts:   cloneStringMap(seed.ModelDefaultReasoningEfforts),
		ReasoningEffortMap:             cloneStringMap(seed.ReasoningEffortMap),
		ModelReasoningEffortMap:        cloneNestedStringMap(seed.ModelReasoningEffortMap),
		ModelContextWindows:            cloneIntMap(seed.ModelContextWindows),
		ModelInputModalities:           cloneStringSlices(seed.ModelInputModalities),
		ModelMaxInputTokens:            cloneIntMap(seed.ModelMaxInputTokens),
		ModelMaxOutputTokens:           cloneIntMap(seed.ModelMaxOutputTokens),
		NoVisionModels:                 append([]string(nil), seed.NoVisionModels...),
		NoReasoningModels:              append([]string(nil), seed.NoReasoningModels...),
		NoTemperatureModels:            append([]string(nil), seed.NoTemperatureModels...),
		NoTopPModels:                   append([]string(nil), seed.NoTopPModels...),
		NoPenaltyModels:                append([]string(nil), seed.NoPenaltyModels...),
		AutoToolChoiceOnlyModels:       append([]string(nil), seed.AutoToolChoiceOnlyModels...),
		PreserveReasoningContentModels: append([]string(nil), seed.PreserveReasoningContentModels...),
		ThinkingToggleModels:           append([]string(nil), seed.ThinkingToggleModels...),
		ThinkingBudgetModels:           append([]string(nil), seed.ThinkingBudgetModels...),
		LiveModels:                     &liveModels, FreeTier: seed.FreeTier,
	}
}

func optionalTrue(value bool) *bool {
	if !value {
		return nil
	}
	return &value
}

func cloneStringMap[V ~string](input map[string]V) map[string]string {
	if input == nil {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = string(value)
	}
	return output
}

func cloneIntMap(input map[string]int) map[string]int {
	if input == nil {
		return nil
	}
	output := make(map[string]int, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func cloneStringSlices(input map[string][]string) map[string][]string {
	if input == nil {
		return nil
	}
	output := make(map[string][]string, len(input))
	for key, value := range input {
		output[key] = append([]string(nil), value...)
	}
	return output
}

func cloneNestedStringMap(input map[string]map[string]string) map[string]map[string]string {
	if input == nil {
		return nil
	}
	output := make(map[string]map[string]string, len(input))
	for key, value := range input {
		output[key] = cloneStringMap(value)
	}
	return output
}

func runLogout(ctx context.Context, args []string, streams IO) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return fmt.Errorf("usage: ocx logout <provider>")
	}
	_, provider := normalizeLoginProvider(args[0])
	store, err := accountStore()
	if err != nil {
		return err
	}
	accounts, err := store.ListAccounts(provider)
	if err != nil {
		return err
	}
	for _, account := range accounts {
		if _, err := store.RemoveAccount(ctx, provider, account.ID); err != nil {
			return err
		}
	}
	fmt.Fprintf(streams.Out, "Logged out of %s.\n", provider)
	return nil
}

// compile-time checks keep the CLI selection table aligned with flow capabilities.
var (
	_ refreshableLoginFlow = browserLoginFlow{}
	_ loginFlow            = (*oauth.CursorFlow)(nil)
	_ loginFlow            = (*oauth.KimiFlow)(nil)
	_ loginFlow            = (*oauth.GithubCopilotFlow)(nil)
)
