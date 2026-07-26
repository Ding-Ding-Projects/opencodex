package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

const resetCreditBaseURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
const codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

type codexLoginSession struct {
	cancel            context.CancelFunc
	code              chan string
	expectedAccountID string
	status            management.CodexLoginStatus
}

type cliCodexAuthManagement struct {
	config     *config.Config
	configPath string
	store      *oauth.CredentialStore
	quota      *codex.QuotaStore
	client     *http.Client
	loginFlow  func() (loginFlow, error)
	resetBase  string
	usageURL   string
	mainToken  func() (codex.MainAccountToken, bool)
	openURL    func(string) error
	now        func() time.Time
	mu         sync.Mutex
	sessions   map[string]*codexLoginSession
	mainID     string
	mainEmail  string
	mainPlan   string
}

var _ management.CodexAuthBackend = (*cliCodexAuthManagement)(nil)
var _ management.CodexResetCreditConsumer = (*cliCodexAuthManagement)(nil)

func newCodexAuthManagement(cfg *config.Config, configPath string, store *oauth.CredentialStore, quota *codex.QuotaStore, client *http.Client) *cliCodexAuthManagement {
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			codexHome = filepath.Join(home, ".codex")
		}
	}
	return &cliCodexAuthManagement{
		config: cfg, configPath: configPath, store: store, quota: quota, client: client,
		resetBase: resetCreditBaseURL, usageURL: codexUsageURL, openURL: platform.OpenURL, now: time.Now,
		sessions: make(map[string]*codexLoginSession), mainEmail: "Codex App login",
		mainToken: func() (codex.MainAccountToken, bool) {
			return codex.ReadMainAccountToken(filepath.Join(codexHome, "auth.json"))
		},
		loginFlow: func() (loginFlow, error) { return newLoginFlow("chatgpt", client, "") },
	}
}

func (m *cliCodexAuthManagement) ListCodexAccounts(ctx context.Context, forceRefresh bool) ([]management.CodexAuthAccount, error) {
	set, _, err := m.store.GetAccountSet("openai")
	if err != nil {
		return nil, err
	}
	credentials := make(map[string]oauth.ProviderAccount, len(set.Accounts))
	for _, account := range set.Accounts {
		credentials[account.ID] = account
	}
	m.mu.Lock()
	configured := append([]config.CodexAccount(nil), m.config.CodexAccounts...)
	m.mu.Unlock()
	mainToken, hasMain := m.mainToken()
	mainIdentity := ""
	if hasMain {
		mainIdentity = mainToken.ChatGPTAccountID
	}
	m.mu.Lock()
	if mainIdentity != m.mainID {
		m.mainID, m.mainEmail, m.mainPlan = mainIdentity, "Codex App login", ""
		m.quota.Clear(codex.MainCodexAccountID)
	}
	mainEmail, mainPlan := m.mainEmail, m.mainPlan
	m.mu.Unlock()
	if hasMain && (forceRefresh || !m.hasQuota(codex.MainCodexAccountID)) {
		if usage, ok := m.fetchUsage(ctx, mainToken.AccessToken, mainToken.ChatGPTAccountID); ok {
			m.quota.SetParsed(codex.MainCodexAccountID, codex.ParseUsageQuota(usage))
			if usage.Email != nil && strings.TrimSpace(*usage.Email) != "" {
				mainEmail = strings.TrimSpace(*usage.Email)
			}
			if usage.PlanType != nil {
				mainPlan = strings.TrimSpace(*usage.PlanType)
			}
			m.mu.Lock()
			if m.mainID == mainIdentity {
				m.mainEmail, m.mainPlan = mainEmail, mainPlan
			}
			m.mu.Unlock()
		}
	}
	result := make([]management.CodexAuthAccount, 0, len(configured)+1)
	result = append(result, m.accountProjection(codex.MainCodexAccountID, "", mainEmail, mainPlan, "", true, hasMain, !hasMain))
	for _, account := range configured {
		if account.IsMain {
			continue
		}
		stored, found := credentials[account.ID]
		if found && (forceRefresh || !m.hasQuota(account.ID)) {
			if usage, ok := m.fetchUsage(ctx, stored.Credential.Access, stored.Credential.AccountID); ok {
				m.quota.SetParsed(account.ID, codex.ParseUsageQuota(usage))
			}
		}
		result = append(result, m.accountProjection(account.ID, account.Alias, account.Email, account.Plan, account.LogLabel, false, found && stored.Credential.Access != "", !found || stored.NeedsReauth))
	}
	return result, nil
}

func (m *cliCodexAuthManagement) hasQuota(accountID string) bool {
	_, found := m.quota.Get(accountID)
	return found
}

func (m *cliCodexAuthManagement) accountProjection(id, alias, email, plan, logLabel string, main, hasCredential, needsReauth bool) management.CodexAuthAccount {
	var quota *management.CodexAccountQuota
	if value, ok := m.quota.Get(id); ok {
		quota = &management.CodexAccountQuota{
			WeeklyPercent: value.WeeklyPercent, MonthlyPercent: value.MonthlyPercent,
			WeeklyResetAt: value.WeeklyResetAt, MonthlyResetAt: value.MonthlyResetAt,
			ResetCredits: value.ResetCredits, UpdatedAt: value.UpdatedAt,
		}
	}
	result := management.CodexAuthAccount{
		ID: id, Alias: alias, Email: email, Plan: optionalString(plan), LogLabel: logLabel,
		IsMain: main, Quota: quota, NeedsReauth: needsReauth, HasCredential: hasCredential,
	}
	result.Health = projectOAuthAccountHealth(oauthHealthInput{NeedsReauth: needsReauth, ReauthReason: "refresh_failed", Now: m.now()})
	result.HealthLabel, result.HealthSummary, result.HealthAction = oauthAccountHealthFields("codex", id, result.Health)
	return result
}

func (m *cliCodexAuthManagement) fetchUsage(ctx context.Context, accessToken, accountID string) (codex.WhamUsageResponse, bool) {
	usage, _, ok := m.fetchUsageWithRemaining(ctx, accessToken, accountID)
	return usage, ok
}

func (m *cliCodexAuthManagement) fetchUsageWithRemaining(ctx context.Context, accessToken, accountID string) (codex.WhamUsageResponse, *int, bool) {
	if strings.TrimSpace(accessToken) == "" {
		return codex.WhamUsageResponse{}, nil, false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, m.usageURL, nil)
	if err != nil {
		return codex.WhamUsageResponse{}, nil, false
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	if accountID != "" {
		request.Header.Set("ChatGPT-Account-Id", accountID)
	}
	response, err := m.httpClient().Do(request)
	if err != nil {
		return codex.WhamUsageResponse{}, nil, false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return codex.WhamUsageResponse{}, nil, false
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return codex.WhamUsageResponse{}, nil, false
	}
	var usage codex.WhamUsageResponse
	if json.Unmarshal(payload, &usage) != nil {
		return codex.WhamUsageResponse{}, nil, false
	}
	var presence struct {
		RateLimitResetCredits *struct {
			AvailableCount *int `json:"available_count"`
		} `json:"rate_limit_reset_credits"`
	}
	if json.Unmarshal(payload, &presence) != nil {
		return codex.WhamUsageResponse{}, nil, false
	}
	var remaining *int
	if presence.RateLimitResetCredits != nil && presence.RateLimitResetCredits.AvailableCount != nil {
		value := *presence.RateLimitResetCredits.AvailableCount
		remaining = &value
	} else {
		// codex.UsageResetCredits uses an int for compatibility. Remove an
		// object that omitted available_count so quota parsing cannot invent 0.
		usage.RateLimitResetCredits = nil
	}
	return usage, remaining, true
}

func (m *cliCodexAuthManagement) ImportCodexAccount(ctx context.Context, input management.CodexAccountImport) error {
	m.mu.Lock()
	for _, account := range m.config.CodexAccounts {
		if account.ID == input.ID {
			m.mu.Unlock()
			return &management.BackendError{Status: http.StatusBadRequest, Message: "Account id already exists: " + input.ID}
		}
	}
	m.mu.Unlock()
	if _, found, err := m.store.GetAccountCredential("openai", input.ID); err != nil {
		return err
	} else if found {
		return &management.BackendError{Status: http.StatusBadRequest, Message: "Account id already exists: " + input.ID}
	}
	credential := oauth.OAuthCredentials{
		Access: input.AccessToken, Refresh: input.RefreshToken, Expires: m.now().Add(time.Hour).UnixMilli(),
		Email: input.Email, AccountID: input.ChatGPTAccountID, Source: oauth.SourceManual,
	}
	if err := m.store.SaveNamedAccount(ctx, "openai", input.ID, credential); err != nil {
		return err
	}
	if err := m.upsertConfigAccount(config.CodexAccount{ID: input.ID, Email: input.Email, Plan: input.Plan, ChatGPTAccountID: input.ChatGPTAccountID}); err != nil {
		_, _ = m.store.RemoveAccount(context.Background(), "openai", input.ID)
		return err
	}
	return nil
}

func (m *cliCodexAuthManagement) DeleteCodexAccount(ctx context.Context, id string) error {
	if id == codex.MainCodexAccountID {
		return &management.BackendError{Status: http.StatusBadRequest, Message: "Main Codex account cannot be removed"}
	}
	credential, credentialFound, credentialErr := m.store.GetAccountCredential("openai", id)
	if credentialErr != nil {
		return credentialErr
	}
	removed, err := m.store.RemoveAccount(ctx, "openai", id)
	if err != nil {
		return err
	}
	if !removed {
		return &management.BackendError{Status: http.StatusNotFound, Message: "Account not found"}
	}
	m.mu.Lock()
	previous := append([]config.CodexAccount(nil), m.config.CodexAccounts...)
	previousActive := m.config.ActiveCodexAccountID
	next := make([]config.CodexAccount, 0, len(previous))
	for _, account := range previous {
		if account.ID != id {
			next = append(next, account)
		}
	}
	m.config.CodexAccounts = next
	if m.config.ActiveCodexAccountID == id {
		m.config.ActiveCodexAccountID = ""
	}
	err = config.Save(m.configPath, m.config)
	if err != nil {
		m.config.CodexAccounts = previous
		m.config.ActiveCodexAccountID = previousActive
	}
	m.mu.Unlock()
	if err != nil && credentialFound {
		_ = m.store.SaveNamedAccount(context.Background(), "openai", id, credential)
	}
	if err == nil {
		m.quota.Clear(id)
	}
	return err
}

func (m *cliCodexAuthManagement) SetCodexAccountAlias(ctx context.Context, id, alias string) (bool, error) {
	m.mu.Lock()
	index := -1
	for position := range m.config.CodexAccounts {
		if m.config.CodexAccounts[position].ID == id {
			index = position
			break
		}
	}
	if index < 0 {
		m.mu.Unlock()
		return false, nil
	}
	previous := m.config.CodexAccounts[index].Alias
	m.config.CodexAccounts[index].Alias = alias
	err := config.Save(m.configPath, m.config)
	if err != nil {
		m.config.CodexAccounts[index].Alias = previous
	}
	m.mu.Unlock()
	if err != nil {
		return false, err
	}
	_, err = m.store.SetAccountAlias(ctx, "openai", id, alias)
	return true, err
}

func (m *cliCodexAuthManagement) CodexResetCredits(ctx context.Context, id string) (management.ResetCredits, error) {
	request, err := m.resetCreditRequest(ctx, http.MethodGet, id, nil)
	if err != nil {
		return management.ResetCredits{}, err
	}
	response, err := m.httpClient().Do(request)
	if err != nil {
		return management.ResetCredits{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return management.ResetCredits{}, &management.BackendError{Status: response.StatusCode, Message: "Upstream error " + response.Status}
	}
	var raw struct {
		Credits []management.ResetCredit `json:"credits"`
		Nested  struct {
			AvailableCount *int `json:"available_count"`
		} `json:"rate_limit_reset_credits"`
		AvailableCount *int `json:"available_count"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&raw); err != nil {
		return management.ResetCredits{}, err
	}
	available := raw.AvailableCount
	if available == nil {
		available = raw.Nested.AvailableCount
	}
	if available != nil {
		m.quota.Update(id, nil, nil, nil, nil, available)
	}
	return management.ResetCredits{Credits: raw.Credits, AvailableCount: available}, nil
}

func (m *cliCodexAuthManagement) ConsumeCodexResetCredit(ctx context.Context, id string) (management.ResetCreditConsumeResult, error) {
	body := strings.NewReader(fmt.Sprintf(`{"redeem_request_id":%q}`, newFlowID("redeem")))
	request, err := m.resetCreditRequest(ctx, http.MethodPost, id, body)
	if err != nil {
		return management.ResetCreditConsumeResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := m.httpClient().Do(request)
	if err != nil {
		return management.ResetCreditConsumeResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return management.ResetCreditConsumeResult{}, &management.BackendError{Status: response.StatusCode, Message: "Upstream error " + response.Status}
	}
	var result struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return management.ResetCreditConsumeResult{}, err
	}
	consume := management.ResetCreditConsumeResult{Code: result.Code}
	if result.Code == "reset" || result.Code == "already_redeemed" {
		consume.Remaining = m.refreshAccountUsage(ctx, id)
	}
	return consume, nil
}

// refreshAccountUsage updates shared state only from this request's fresh WHAM
// response. A failed or credits-omitting refresh never invents a decrement.
func (m *cliCodexAuthManagement) refreshAccountUsage(ctx context.Context, id string) *int {
	accessToken, accountID, err := m.accountAuth(id)
	if err != nil {
		return nil
	}
	usage, remaining, ok := m.fetchUsageWithRemaining(ctx, accessToken, accountID)
	if !ok {
		return nil
	}
	if parsed := codex.ParseUsageQuota(usage); parsed != nil {
		m.quota.SetParsed(id, parsed)
	}
	return remaining
}

func (m *cliCodexAuthManagement) accountAuth(id string) (string, string, error) {
	if id == codex.MainCodexAccountID {
		token, found := m.mainToken()
		if !found {
			return "", "", &management.BackendError{Status: http.StatusUnauthorized, Message: "Main Codex account not logged in"}
		}
		return token.AccessToken, token.ChatGPTAccountID, nil
	}
	credential, found, err := m.store.GetAccountCredential("openai", id)
	if err != nil {
		return "", "", err
	}
	if !found {
		return "", "", &management.BackendError{Status: http.StatusNotFound, Message: "Unknown Codex account"}
	}
	return credential.Access, credential.AccountID, nil
}

func (m *cliCodexAuthManagement) resetCreditRequest(ctx context.Context, method, id string, body io.Reader) (*http.Request, error) {
	accessToken, accountID, err := m.accountAuth(id)
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(m.resetBase, "/")
	if method == http.MethodPost {
		endpoint += "/consume"
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("ChatGPT-Account-Id", accountID)
	return request, nil
}

func (m *cliCodexAuthManagement) StartCodexLogin(_ context.Context, options management.CodexLoginOptions) (management.CodexLoginStart, error) {
	accountID := strings.TrimSpace(options.AccountID)
	if accountID == "" {
		accountID = fmt.Sprintf("chatgpt-%d", m.now().UnixMilli())
	}
	m.mu.Lock()
	configured := false
	expectedAccountID := ""
	for _, account := range m.config.CodexAccounts {
		if account.ID == accountID {
			configured, expectedAccountID = true, account.ChatGPTAccountID
			break
		}
	}
	m.mu.Unlock()
	credential, stored, err := m.store.GetAccountCredential("openai", accountID)
	if err != nil {
		return management.CodexLoginStart{}, err
	}
	if stored && expectedAccountID == "" {
		expectedAccountID = credential.AccountID
	}
	if (configured || stored) && !options.Reauth {
		return management.CodexLoginStart{}, &management.BackendError{Status: http.StatusBadRequest, Message: "Account id already exists: " + accountID}
	}
	if options.Reauth && !configured {
		return management.CodexLoginStart{}, &management.BackendError{Status: http.StatusNotFound, Message: "Unknown pool account for reauth"}
	}
	flow, err := m.loginFlow()
	if err != nil {
		return management.CodexLoginStart{}, err
	}
	flowID := newFlowID("flow")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	session := &codexLoginSession{cancel: cancel, code: make(chan string, 1), expectedAccountID: expectedAccountID, status: management.CodexLoginStatus{Status: "starting", AccountID: accountID}}
	manual := func(ctx context.Context, _ string) (string, error) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case input := <-session.code:
			return input, nil
		}
	}
	switch typed := flow.(type) {
	case browserLoginFlow:
		typed.manual = manual
		flow = typed
	}
	m.mu.Lock()
	m.sessions[flowID] = session
	m.mu.Unlock()
	started := make(chan management.CodexLoginStart, 1)
	go m.runCodexLogin(ctx, flowID, accountID, flow, session, started)
	select {
	case result := <-started:
		result.FlowID = flowID
		if result.URL != "" && m.openURL != nil {
			_ = m.openURL(result.URL)
		}
		return result, nil
	case <-time.After(15 * time.Second):
		return management.CodexLoginStart{FlowID: flowID, Instructions: "OAuth login is starting; poll status for progress."}, nil
	case <-ctx.Done():
		return management.CodexLoginStart{}, ctx.Err()
	}
}

func (m *cliCodexAuthManagement) runCodexLogin(ctx context.Context, flowID, accountID string, flow loginFlow, session *codexLoginSession, started chan<- management.CodexLoginStart) {
	defer session.cancel()
	sent := false
	credential, err := flow.Login(ctx, func(auth oauth.Authorization) {
		m.setCodexLoginStatus(flowID, func(status *management.CodexLoginStatus) { status.Status = "pending" })
		if !sent {
			sent = true
			started <- management.CodexLoginStart{URL: auth.URL, Instructions: auth.Instructions}
		}
	})
	if !sent {
		started <- management.CodexLoginStart{}
	}
	if err == nil && session.expectedAccountID != "" && credential.AccountID != session.expectedAccountID {
		err = errors.New("signed-in ChatGPT account does not match this pool account")
	}
	if err == nil {
		err = m.store.SaveNamedAccount(ctx, "openai", accountID, credential)
	}
	if err == nil {
		err = m.upsertConfigAccount(config.CodexAccount{ID: accountID, Email: credential.Email, ChatGPTAccountID: credential.AccountID})
	}
	m.setCodexLoginStatus(flowID, func(status *management.CodexLoginStatus) {
		if status.Status == "cancelled" {
			return
		}
		status.DoneAt = m.now().UnixMilli()
		if err != nil {
			status.Status, status.Error = "error", err.Error()
		} else {
			status.Status, status.Email = "complete", credential.Email
		}
	})
}

func (m *cliCodexAuthManagement) SubmitCodexLoginCode(ctx context.Context, flowID, input string) error {
	m.mu.Lock()
	session := m.sessions[flowID]
	terminal := session != nil && (session.status.Status == "complete" || session.status.Status == "error" || session.status.Status == "cancelled")
	m.mu.Unlock()
	if session == nil {
		return &management.BackendError{Status: http.StatusNotFound, Message: "OAuth flow not found"}
	}
	if terminal {
		return &management.BackendError{Status: http.StatusConflict, Message: "OAuth flow is already complete"}
	}
	select {
	case session.code <- strings.TrimSpace(input):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		return errors.New("OAuth code is already pending")
	}
}

func (m *cliCodexAuthManagement) CancelCodexLogin(_ context.Context, flowID string) (bool, error) {
	m.mu.Lock()
	session := m.sessions[flowID]
	if session == nil || session.status.Status == "complete" || session.status.Status == "error" || session.status.Status == "cancelled" {
		m.mu.Unlock()
		return false, nil
	}
	session.cancel()
	session.status.Status, session.status.Error, session.status.DoneAt = "cancelled", "", m.now().UnixMilli()
	m.mu.Unlock()
	return true, nil
}

func (m *cliCodexAuthManagement) CodexLoginStatus(_ context.Context, flowID, accountID string, _ bool) management.CodexLoginStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if session := m.sessions[flowID]; session != nil {
		return session.status
	}
	return management.CodexLoginStatus{Status: "idle", AccountID: accountID}
}

func (m *cliCodexAuthManagement) setCodexLoginStatus(flowID string, update func(*management.CodexLoginStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if session := m.sessions[flowID]; session != nil {
		update(&session.status)
	}
}

func (m *cliCodexAuthManagement) upsertConfigAccount(account config.CodexAccount) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := append([]config.CodexAccount(nil), m.config.CodexAccounts...)
	for index := range m.config.CodexAccounts {
		if m.config.CodexAccounts[index].ID == account.ID {
			account.Alias = m.config.CodexAccounts[index].Alias
			m.config.CodexAccounts[index] = account
			if err := config.Save(m.configPath, m.config); err != nil {
				m.config.CodexAccounts = previous
				return err
			}
			return nil
		}
	}
	m.config.CodexAccounts = append(m.config.CodexAccounts, account)
	if err := config.Save(m.configPath, m.config); err != nil {
		m.config.CodexAccounts = previous
		return err
	}
	return nil
}

func (m *cliCodexAuthManagement) httpClient() *http.Client {
	if m.client != nil {
		return m.client
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func newFlowID(prefix string) string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err == nil {
		return prefix + "-" + hex.EncodeToString(buffer)
	}
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	copy := value
	return &copy
}
