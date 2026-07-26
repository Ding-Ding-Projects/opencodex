package management

import (
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

var codexAccountIDPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

func (a *API) handleCodexAuth(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/codex-auth/") || r.URL.Path == "/api/codex-auth/quota" {
		return false
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/codex-auth/active":
		a.mu.RLock()
		active := a.config.ActiveCodexAccountID
		autoSwitch := a.config.AutoSwitchThreshold
		failover := a.config.UpstreamFailoverThreshold
		a.mu.RUnlock()
		if autoSwitch == 0 {
			autoSwitch = 80
		}
		if failover == 0 {
			failover = 3
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{
			{name: "activeCodexAccountId", value: nullable(active)},
			{name: "autoSwitchThreshold", value: autoSwitch},
			{name: "upstreamFailoverThreshold", value: failover},
		})
		return true
	case "PUT /api/codex-auth/active":
		a.putActiveCodexAccount(w, r)
		return true
	case "PUT /api/codex-auth/auto-switch":
		a.putCodexThreshold(w, r, true)
		return true
	case "PUT /api/codex-auth/failover":
		a.putCodexThreshold(w, r, false)
		return true
	}
	if a.codexAuth == nil {
		writeError(w, http.StatusNotImplemented, "Codex auth management is not configured")
		return true
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/codex-auth/accounts":
		refresh := r.URL.Query().Get("refresh")
		accounts, err := a.codexAuth.ListCodexAccounts(r.Context(), refresh == "1" || refresh == "true")
		if err != nil {
			writeBackendError(w, err, "Codex accounts could not be read")
			return true
		}
		for index := range accounts {
			accounts[index].Email = maskOAuthEmail(accounts[index].Email)
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "accounts", value: accounts}})
	case "POST /api/codex-auth/accounts":
		a.importCodexAccount(w, r)
	case "DELETE /api/codex-auth/accounts":
		id := r.URL.Query().Get("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "Missing id")
			return true
		}
		if err := a.codexAuth.DeleteCodexAccount(r.Context(), id); err != nil {
			writeBackendError(w, err, "Account could not be removed")
			return true
		}
		writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}})
	case "PUT /api/codex-auth/accounts/alias":
		a.putCodexAccountAlias(w, r)
	case "GET /api/codex-auth/reset-credits":
		id := r.URL.Query().Get("accountId")
		if id == "" {
			writeError(w, http.StatusBadRequest, "accountId required")
			return true
		}
		result, err := a.codexAuth.CodexResetCredits(r.Context(), id)
		if err != nil {
			writeBackendError(w, err, "Reset credit lookup failed")
			return true
		}
		if result.Credits == nil {
			result.Credits = []ResetCredit{}
		}
		writeJSON(w, http.StatusOK, result)
	case "POST /api/codex-auth/reset-credits/consume":
		var body struct {
			AccountID string `json:"accountId"`
		}
		if !decodeJSON(w, r, &body) {
			return true
		}
		if body.AccountID == "" {
			writeError(w, http.StatusBadRequest, "accountId required")
			return true
		}
		var result ResetCreditConsumeResult
		var err error
		if backend, ok := a.codexAuth.(CodexResetCreditConsumer); ok {
			result, err = backend.ConsumeCodexResetCredit(r.Context(), body.AccountID)
		} else if backend, ok := a.codexAuth.(legacyCodexResetCreditConsumer); ok {
			result.Code, err = backend.ConsumeCodexResetCredit(r.Context(), body.AccountID)
		} else {
			writeError(w, http.StatusNotImplemented, "Reset credit consume is not configured")
			return true
		}
		if err != nil {
			writeBackendError(w, err, "Reset credit consume failed")
			return true
		}
		if result.Code == "" {
			result.Code = "unknown"
		}
		response := orderedJSONObject{{name: "code", value: result.Code}}
		if result.Remaining != nil {
			response = append(response, orderedJSONField{name: "remaining", value: *result.Remaining})
		}
		writeJSON(w, http.StatusOK, response)
	case "POST /api/codex-auth/login":
		a.startCodexLogin(w, r)
	case "POST /api/codex-auth/login/code":
		a.submitCodexLoginCode(w, r)
	case "POST /api/codex-auth/login/cancel":
		a.cancelCodexLogin(w, r)
	case "GET /api/codex-auth/login-status":
		status := a.codexAuth.CodexLoginStatus(r.Context(), r.URL.Query().Get("flowId"), strings.TrimSpace(r.URL.Query().Get("accountId")), r.URL.Query().Get("reauth") == "1")
		status.Email = maskOAuthEmail(status.Email)
		status.Error = config.RedactString(status.Error)
		writeJSON(w, http.StatusOK, status)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
	return true
}

func (a *API) importCodexAccount(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT") != "1" {
		writeJSON(w, http.StatusForbidden, orderedJSONObject{{name: "error", value: "Manual Codex account import is disabled. Use OAuth login to add a pool account."}, {name: "code", value: "manual_import_disabled"}})
		return
	}
	var body struct{ ID, Email, Plan, AccessToken, RefreshToken, ChatGPTAccountID string }
	// Explicit tags preserve the upstream camel-case contract.
	var raw struct {
		ID               string `json:"id"`
		Email            string `json:"email"`
		Plan             string `json:"plan,omitempty"`
		AccessToken      string `json:"accessToken"`
		RefreshToken     string `json:"refreshToken"`
		ChatGPTAccountID string `json:"chatgptAccountId"`
	}
	if !decodeJSON(w, r, &raw) {
		return
	}
	body.ID, body.Email, body.Plan = raw.ID, raw.Email, raw.Plan
	body.AccessToken, body.RefreshToken, body.ChatGPTAccountID = raw.AccessToken, raw.RefreshToken, raw.ChatGPTAccountID
	if body.ID == "" || body.Email == "" || body.AccessToken == "" || body.RefreshToken == "" || body.ChatGPTAccountID == "" {
		writeError(w, http.StatusBadRequest, "Missing required fields")
		return
	}
	if !codexAccountIDPattern.MatchString(body.ID) {
		writeError(w, http.StatusBadRequest, "Invalid account id format")
		return
	}
	if len(body.AccessToken) > 10_000 || len(body.RefreshToken) > 10_000 {
		writeError(w, http.StatusBadRequest, "Input too large")
		return
	}
	err := a.codexAuth.ImportCodexAccount(r.Context(), CodexAccountImport{ID: body.ID, Email: body.Email, Plan: body.Plan, AccessToken: body.AccessToken, RefreshToken: body.RefreshToken, ChatGPTAccountID: body.ChatGPTAccountID})
	if err != nil {
		writeBackendError(w, err, "Codex account import failed")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}})
}

func (a *API) putActiveCodexAccount(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AccountID *string `json:"accountId"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	active := ""
	if body.AccountID != nil {
		active = *body.AccountID
	}
	if active != "" && active != codex.MainCodexAccountID {
		a.mu.RLock()
		exists := false
		for _, account := range a.config.CodexAccounts {
			if account.ID == active {
				exists = true
				break
			}
		}
		a.mu.RUnlock()
		if !exists {
			writeError(w, http.StatusBadRequest, "Account not found")
			return
		}
	}
	a.mu.Lock()
	previous := a.config.ActiveCodexAccountID
	a.config.ActiveCodexAccountID = active
	err := a.saveProviderLocked("openai")
	if err != nil {
		a.config.ActiveCodexAccountID = previous
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save active Codex account failed")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "activeCodexAccountId", value: nullable(active)}})
}

func (a *API) putCodexThreshold(w http.ResponseWriter, r *http.Request, autoSwitch bool) {
	var body struct {
		Threshold *int `json:"threshold"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	maxValue, message := 20, "Threshold must be an integer 0-20"
	if autoSwitch {
		maxValue, message = 100, "Threshold must be an integer 0-100"
	}
	if body.Threshold == nil || *body.Threshold < 0 || *body.Threshold > maxValue {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	a.mu.Lock()
	oldAuto, oldFailover := a.config.AutoSwitchThreshold, a.config.UpstreamFailoverThreshold
	if autoSwitch {
		a.config.AutoSwitchThreshold = *body.Threshold
	} else {
		a.config.UpstreamFailoverThreshold = *body.Threshold
	}
	err := a.saveProviderLocked("openai")
	if err != nil {
		a.config.AutoSwitchThreshold, a.config.UpstreamFailoverThreshold = oldAuto, oldFailover
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save Codex account settings failed")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}})
}

func (a *API) putCodexAccountAlias(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID    string  `json:"id"`
		Alias *string `json:"alias"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := strings.TrimSpace(body.ID)
	if !codexAccountIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "Invalid account id format")
		return
	}
	if id == codex.MainCodexAccountID {
		writeError(w, http.StatusBadRequest, "Main Codex account alias is not configurable")
		return
	}
	if body.Alias == nil {
		writeError(w, http.StatusBadRequest, "Alias must be a string of at most 80 printable characters")
		return
	}
	alias := strings.TrimSpace(*body.Alias)
	if len([]rune(alias)) > 80 || strings.IndexFunc(alias, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		writeError(w, http.StatusBadRequest, "Alias must be a string of at most 80 printable characters")
		return
	}
	updated, err := a.codexAuth.SetCodexAccountAlias(r.Context(), id, alias)
	if err != nil {
		writeBackendError(w, err, "Account alias could not be updated")
		return
	}
	if !updated {
		writeError(w, http.StatusNotFound, "Account not found")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "id", value: id}, {name: "alias", value: nullable(alias)}})
}

func (a *API) startCodexLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID     string `json:"id,omitempty"`
		Reauth bool   `json:"reauth,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	id := strings.TrimSpace(body.ID)
	if id != "" && !codexAccountIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "Invalid account id format")
		return
	}
	if body.Reauth && id == "" {
		writeError(w, http.StatusBadRequest, "id required for reauth")
		return
	}
	started, err := a.codexAuth.StartCodexLogin(r.Context(), CodexLoginOptions{AccountID: id, Reauth: body.Reauth})
	if err != nil {
		writeBackendError(w, err, "Codex login could not start")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "flowId", value: started.FlowID}, {name: "url", value: started.URL}, {name: "instructions", value: started.Instructions}})
}

func (a *API) submitCodexLoginCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FlowID string `json:"flowId"`
		Input  string `json:"input"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.FlowID = strings.TrimSpace(body.FlowID)
	if body.FlowID == "" {
		writeError(w, http.StatusBadRequest, "flowId required")
		return
	}
	if len(body.Input) > 4096 {
		writeError(w, http.StatusBadRequest, "input too long")
		return
	}
	if err := a.codexAuth.SubmitCodexLoginCode(r.Context(), body.FlowID, body.Input); err != nil {
		writeBackendError(w, err, "OAuth code was rejected")
		return
	}
	writeJSON(w, http.StatusAccepted, orderedJSONObject{{name: "ok", value: true}})
}

func (a *API) cancelCodexLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FlowID string `json:"flowId,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	cancelled, err := a.codexAuth.CancelCodexLogin(r.Context(), body.FlowID)
	if err != nil {
		writeBackendError(w, err, "OAuth login could not be cancelled")
		return
	}
	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "cancelled", value: cancelled}})
}

func writeBackendError(w http.ResponseWriter, err error, fallback string) {
	var backend *BackendError
	if errors.As(err, &backend) {
		status := backend.Status
		if status < 400 || status > 599 {
			status = http.StatusInternalServerError
		}
		message := config.RedactString(backend.Message)
		if message == "" {
			message = fallback
		}
		if backend.Code != "" {
			writeJSON(w, status, orderedJSONObject{{name: "error", value: message}, {name: "code", value: backend.Code}})
			return
		}
		writeError(w, status, message)
		return
	}
	var statusError interface {
		error
		HTTPStatus() int
		ErrorCode() string
	}
	if errors.As(err, &statusError) {
		status := statusError.HTTPStatus()
		if status < 400 || status > 599 {
			status = http.StatusInternalServerError
		}
		message := config.RedactString(statusError.Error())
		if message == "" {
			message = fallback
		}
		if code := statusError.ErrorCode(); code != "" {
			writeJSON(w, status, orderedJSONObject{{name: "error", value: message}, {name: "code", value: code}})
			return
		}
		writeError(w, status, message)
		return
	}
	writeError(w, http.StatusInternalServerError, fallback)
}
