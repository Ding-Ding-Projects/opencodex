package management

import (
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func (a *API) handleOAuth(w http.ResponseWriter, request *http.Request) bool {
	if !strings.HasPrefix(request.URL.Path, "/api/oauth/") {
		return false
	}
	if a.oauth == nil {
		writeError(w, http.StatusNotImplemented, "OAuth management is not configured")
		return true
	}
	switch request.Method + " " + request.URL.Path {
	case "GET /api/oauth/providers":
		writeJSON(w, http.StatusOK, map[string]any{"providers": normalizedOAuthProviders(a.oauth.Providers())})
	case "POST /api/oauth/login":
		a.startOAuthLogin(w, request)
	case "POST /api/oauth/login/cancel":
		a.cancelOAuthLogin(w, request)
	case "POST /api/oauth/login/code":
		a.submitOAuthCode(w, request)
	case "GET /api/oauth/status":
		provider, ok := a.oauthQueryProvider(w, request)
		if ok {
			writeJSON(w, http.StatusOK, safeOAuthStatus(a.oauth.Status(provider)))
		}
	case "POST /api/oauth/logout":
		provider, ok := a.oauthQueryProvider(w, request)
		if !ok {
			return true
		}
		if err := a.oauth.Logout(request.Context(), provider); err != nil {
			writeError(w, http.StatusConflict, "OAuth logout failed")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	case "GET /api/oauth/accounts":
		a.listOAuthAccounts(w, request)
	case "PUT /api/oauth/accounts/active":
		a.setActiveOAuthAccount(w, request)
	case "PUT /api/oauth/accounts/alias":
		a.setOAuthAccountAlias(w, request)
	case "DELETE /api/oauth/accounts":
		a.removeOAuthAccount(w, request)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func (a *API) startOAuthLogin(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Provider  string `json:"provider"`
		Add       bool   `json:"addAccount,omitempty"`
		AccountID string `json:"accountId,omitempty"`
		Reauth    bool   `json:"reauth,omitempty"`
	}
	if !decodeJSON(w, request, &body) {
		return
	}
	provider, ok := a.oauthProvider(w, body.Provider)
	if !ok {
		return
	}
	body.AccountID = strings.TrimSpace(body.AccountID)
	if body.AccountID != "" {
		accounts, err := a.oauth.Accounts(provider)
		if err != nil {
			writeError(w, http.StatusConflict, "OAuth accounts could not be read")
			return
		}
		if !oauthAccountExists(accounts.Accounts, body.AccountID) {
			writeError(w, http.StatusNotFound, "Unknown account for reauth")
			return
		}
	}
	options := OAuthLoginOptions{AddAccount: body.Add, Reauth: body.Reauth || body.AccountID != "", ReauthAccountID: body.AccountID}
	started, err := a.oauth.Start(request.Context(), provider, options)
	if err != nil {
		writeError(w, http.StatusConflict, "OAuth login could not start")
		return
	}
	writeJSON(w, http.StatusOK, started)
}

func (a *API) cancelOAuthLogin(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Provider string `json:"provider"`
	}
	if !decodeJSON(w, request, &body) {
		return
	}
	provider, ok := a.oauthProvider(w, body.Provider)
	if !ok {
		return
	}
	cancelled, err := a.oauth.Cancel(provider)
	if err != nil {
		writeError(w, http.StatusConflict, "OAuth login could not be cancelled")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cancelled": cancelled})
}

func (a *API) submitOAuthCode(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Provider string  `json:"provider"`
		Input    *string `json:"input,omitempty"`
		Code     *string `json:"code,omitempty"`
	}
	if !decodeJSON(w, request, &body) {
		return
	}
	provider, ok := a.oauthProvider(w, body.Provider)
	if !ok {
		return
	}
	input := ""
	if body.Input != nil {
		input = *body.Input
	} else if body.Code != nil {
		input = *body.Code
	}
	if len(input) > 4096 {
		writeError(w, http.StatusBadRequest, "input too long")
		return
	}
	if err := a.oauth.SubmitCode(request.Context(), provider, input); err != nil {
		writeError(w, http.StatusConflict, "OAuth code was rejected")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *API) listOAuthAccounts(w http.ResponseWriter, request *http.Request) {
	provider, ok := a.oauthQueryProvider(w, request)
	if !ok {
		return
	}
	accounts, err := a.oauth.Accounts(provider)
	if err != nil {
		writeError(w, http.StatusBadGateway, "OAuth accounts could not be read")
		return
	}
	safe := safeOAuthAccountSet(accounts)
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "activeAccountId", value: nullable(safe.ActiveAccountID)}, {name: "accounts", value: safe.Accounts}})
}

func (a *API) setActiveOAuthAccount(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Provider  string `json:"provider"`
		AccountID string `json:"accountId"`
	}
	if !decodeJSON(w, request, &body) {
		return
	}
	provider, ok := a.oauthProvider(w, body.Provider)
	if !ok {
		return
	}
	body.AccountID = strings.TrimSpace(body.AccountID)
	if body.AccountID == "" {
		writeError(w, http.StatusBadRequest, "missing accountId")
		return
	}
	updated, err := a.oauth.SetActive(request.Context(), provider, body.AccountID)
	if err != nil {
		writeError(w, http.StatusConflict, "account could not be activated")
	} else if !updated {
		writeError(w, http.StatusNotFound, "account not found")
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": provider, "activeAccountId": body.AccountID})
	}
}

func (a *API) setOAuthAccountAlias(w http.ResponseWriter, request *http.Request) {
	var body struct {
		Provider  string  `json:"provider"`
		AccountID string  `json:"accountId"`
		Alias     *string `json:"alias"`
	}
	if !decodeJSON(w, request, &body) {
		return
	}
	provider, ok := a.oauthProvider(w, body.Provider)
	if !ok {
		return
	}
	body.AccountID = strings.TrimSpace(body.AccountID)
	if body.AccountID == "" {
		writeError(w, http.StatusBadRequest, "missing accountId")
		return
	}
	if body.Alias == nil {
		writeError(w, http.StatusBadRequest, "alias must be at most 80 printable characters")
		return
	}
	alias := strings.TrimSpace(*body.Alias)
	if !printableName(alias, 80) {
		writeError(w, http.StatusBadRequest, "alias must be at most 80 printable characters")
		return
	}
	updated, err := a.oauth.SetAlias(request.Context(), provider, body.AccountID, alias)
	if err != nil {
		writeError(w, http.StatusConflict, "account alias could not be updated")
	} else if !updated {
		writeError(w, http.StatusNotFound, "account not found")
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": provider, "accountId": body.AccountID, "alias": nullable(alias)})
	}
}

func (a *API) removeOAuthAccount(w http.ResponseWriter, request *http.Request) {
	provider, ok := a.oauthQueryProvider(w, request)
	if !ok {
		return
	}
	id := strings.TrimSpace(request.URL.Query().Get("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	removed, err := a.oauth.RemoveAccount(request.Context(), provider, id)
	if err != nil {
		writeError(w, http.StatusConflict, "account could not be removed")
	} else if !removed {
		writeError(w, http.StatusNotFound, "account not found")
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *API) oauthQueryProvider(w http.ResponseWriter, request *http.Request) (string, bool) {
	return a.oauthProvider(w, request.URL.Query().Get("provider"))
}

func (a *API) oauthProvider(w http.ResponseWriter, value string) (string, bool) {
	provider := strings.ToLower(strings.TrimSpace(value))
	for _, allowed := range a.oauth.Providers() {
		if provider != "" && provider == strings.ToLower(strings.TrimSpace(allowed)) {
			return provider, true
		}
	}
	writeError(w, http.StatusBadRequest, "unknown oauth provider")
	return "", false
}

func normalizedOAuthProviders(providers []string) []string {
	result := make([]string, 0, len(providers))
	seen := make(map[string]bool, len(providers))
	for _, provider := range providers {
		provider = strings.ToLower(strings.TrimSpace(provider))
		if provider != "" && !seen[provider] {
			seen[provider] = true
			result = append(result, provider)
		}
	}
	return result
}

func oauthAccountExists(accounts []OAuthAccount, id string) bool {
	for _, account := range accounts {
		if account.ID == id {
			return true
		}
	}
	return false
}

func safeOAuthStatus(status OAuthStatus) OAuthStatus {
	status.Accounts = safeOAuthAccounts(status.Accounts)
	status.Error = config.RedactString(status.Error)
	return status
}

func safeOAuthAccountSet(set OAuthAccountSet) OAuthAccountSet {
	set.Accounts = safeOAuthAccounts(set.Accounts)
	return set
}

func safeOAuthAccounts(accounts []OAuthAccount) []OAuthAccount {
	result := make([]OAuthAccount, len(accounts))
	for index, account := range accounts {
		account.Email = maskOAuthEmail(account.Email)
		result[index] = account
	}
	return result
}

func maskOAuthEmail(email string) string {
	email = strings.TrimSpace(email)
	local, domain, found := strings.Cut(email, "@")
	if !found || local == "" || domain == "" {
		return ""
	}
	return string([]rune(local)[0]) + "***@" + domain
}
