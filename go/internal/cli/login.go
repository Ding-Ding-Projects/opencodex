package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runLogin(ctx context.Context, args []string, streams IO) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: ocx login <chatgpt|anthropic>")
	}
	requested := strings.ToLower(strings.TrimSpace(args[0]))
	flowName := requested
	storeName := requested
	if requested == "openai" {
		flowName, storeName = "chatgpt", "openai"
	} else if requested == "chatgpt" {
		storeName = "openai"
	}
	flow, err := oauth.ProviderFlow(flowName, nil)
	if err != nil {
		return err
	}
	browserFlow, ok := flow.(oauth.BrowserFlow)
	if !ok {
		return fmt.Errorf("%s does not support browser login", requested)
	}
	credential, err := oauth.RunBrowserLogin(ctx, browserFlow, func(auth oauth.Authorization) {
		fmt.Fprintln(streams.Out, auth.Instructions)
		fmt.Fprintln(streams.Out, auth.URL)
		_ = platform.OpenURL(auth.URL)
	}, nil)
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
	fmt.Fprintf(streams.Out, "Logged in to %s.\n", storeName)
	return nil
}

func runLogout(ctx context.Context, args []string, streams IO) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return fmt.Errorf("usage: ocx logout <provider>")
	}
	provider := strings.ToLower(strings.TrimSpace(args[0]))
	if provider == "chatgpt" {
		provider = "openai"
	}
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
