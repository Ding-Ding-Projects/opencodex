package codex

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const DefaultSubagentModelFallbackPoll = time.Minute

type FallbackProvider struct {
	ID               string
	Disabled         bool
	CodexAccountMode string
	CanonicalOpenAI  bool
}

type FallbackRoute struct {
	Provider FallbackProvider
}

type SubagentFallbackConfig struct {
	FallbackModels    []string
	DisabledModels    []string
	KnownProviders    []string
	ActiveAccountID   string
	AutoSwitchPercent float64
	PollInterval      time.Duration
	Route             func(model string) (FallbackRoute, error)
	AccountUsable     func(accountID string) bool
	AccountCooling    func(accountID string, now time.Time) bool
	CanProbeAccount   func(accountID string, now time.Time) bool
	AccountPlan       func(accountID string) string
	Quota             func(accountID string) (StoredAccountQuota, bool)
}

type SubagentModelSelection struct {
	Model     string
	Rewritten bool
	Skipped   []string
}

type modelHealthEntry struct {
	UnavailableUntil time.Time
	Reason           string
}

// SubagentFallbackState owns temporary health blocks and quota-prime deduplication.
type SubagentFallbackState struct {
	mu         sync.Mutex
	health     map[string]modelHealthEntry
	primedAt   time.Time
	primeDone  chan struct{}
	primeError error
}

func NewSubagentFallbackState() *SubagentFallbackState {
	return &SubagentFallbackState{health: make(map[string]modelHealthEntry)}
}

func BuildSubagentModelChain(primary string, configured, extra []string) []string {
	chain := make([]string, 0, 1+len(extra)+len(configured))
	seen := map[string]bool{}
	push := func(model string) {
		model = strings.TrimSpace(model)
		key := strings.ToLower(model)
		if model == "" || seen[key] {
			return
		}
		seen[key] = true
		chain = append(chain, model)
	}
	push(primary)
	for _, model := range extra {
		push(model)
	}
	for _, model := range configured {
		push(model)
	}
	return chain
}

func fallbackPoll(config SubagentFallbackConfig) time.Duration {
	if config.PollInterval < time.Second {
		return DefaultSubagentModelFallbackPoll
	}
	return config.PollInterval
}

func fallbackThreshold(config SubagentFallbackConfig) float64 {
	if config.AutoSwitchPercent == 0 {
		return 80
	}
	if config.AutoSwitchPercent < 0 {
		return math.Inf(1)
	}
	return config.AutoSwitchPercent
}

func routeFallback(config SubagentFallbackConfig, model string) (FallbackRoute, bool) {
	if config.Route == nil {
		return FallbackRoute{}, false
	}
	route, err := config.Route(model)
	return route, err == nil
}

func isPoolFallbackRoute(route FallbackRoute) bool { return route.Provider.CodexAccountMode == "pool" }

func fallbackHealthKey(model, accountID string, poolScoped bool) string {
	if !poolScoped {
		accountID = ""
	}
	if accountID == "" {
		accountID = "none"
	}
	return accountID + "::" + strings.ToLower(model)
}

func disabledFallbackModel(model string, disabled []string) bool {
	for _, stored := range disabled {
		if stored == model || slugsEquivalent(stored, model) {
			return true
		}
		if !strings.Contains(model, "/") && slugsEquivalent(stored, "openai/"+model) {
			return true
		}
	}
	return false
}

func routableFallbackModel(model string, config SubagentFallbackConfig) bool {
	slash := strings.Index(model, "/")
	if slash <= 0 {
		return true
	}
	prefix := strings.ToLower(model[:slash])
	for _, known := range config.KnownProviders {
		if strings.EqualFold(known, prefix) {
			return true
		}
	}
	if route, ok := routeFallback(config, model); ok {
		return !route.Provider.Disabled
	}
	return false
}

func resolvedFallbackAccount(config SubagentFallbackConfig, accountID *string) string {
	if accountID != nil {
		return *accountID
	}
	return config.ActiveAccountID
}

func quotaUsageForFallback(quota StoredAccountQuota, plan string) float64 {
	compact := AccountQuota{WeeklyPercent: quota.WeeklyPercent, MonthlyPercent: quota.MonthlyPercent}
	return ComputeCodexUsageScore(&compact, plan)
}

func (s *SubagentFallbackState) NativeQuotaExhausted(model string, config SubagentFallbackConfig, accountID *string) bool {
	route, ok := routeFallback(config, model)
	if !ok || !isPoolFallbackRoute(route) {
		return false
	}
	resolved := resolvedFallbackAccount(config, accountID)
	if resolved == "" || config.Quota == nil {
		return false
	}
	quota, ok := config.Quota(resolved)
	if !ok {
		return false
	}
	plan := ""
	if config.AccountPlan != nil {
		plan = config.AccountPlan(resolved)
	}
	usage := quotaUsageForFallback(quota, plan)
	return usage < CodexUnknownUsageScore && usage >= fallbackThreshold(config)
}

func (s *SubagentFallbackState) ModelHealthBlocked(model string, config SubagentFallbackConfig, accountID *string, now time.Time) bool {
	route, ok := routeFallback(config, model)
	pool := ok && isPoolFallbackRoute(route)
	key := fallbackHealthKey(model, resolvedFallbackAccount(config, accountID), pool)
	s.mu.Lock()
	defer s.mu.Unlock()
	health, found := s.health[key]
	if found && !health.UnavailableUntil.After(now) {
		delete(s.health, key)
		return false
	}
	return found
}

func (s *SubagentFallbackState) ModelUnavailable(model string, config SubagentFallbackConfig, accountID *string, now time.Time) bool {
	if disabledFallbackModel(model, config.DisabledModels) || !routableFallbackModel(model, config) {
		return true
	}
	route, ok := routeFallback(config, model)
	if !ok || route.Provider.Disabled || s.ModelHealthBlocked(model, config, accountID, now) {
		return true
	}
	if !isPoolFallbackRoute(route) {
		return false
	}
	account := resolvedFallbackAccount(config, accountID)
	if account == "" {
		return true
	}
	if config.AccountUsable != nil && !config.AccountUsable(account) {
		return true
	}
	if config.AccountCooling != nil && config.AccountCooling(account, now) {
		if config.CanProbeAccount == nil || !config.CanProbeAccount(account, now) {
			return true
		}
	}
	return s.NativeQuotaExhausted(model, config, accountID)
}

func (s *SubagentFallbackState) Select(primary string, config SubagentFallbackConfig, extra []string, accountID *string, now time.Time, nativeOnly bool) SubagentModelSelection {
	chain := BuildSubagentModelChain(primary, config.FallbackModels, extra)
	selection := SubagentModelSelection{Model: primary}
	for _, candidate := range chain {
		route, routed := routeFallback(config, candidate)
		if nativeOnly && (!routed || !route.Provider.CanonicalOpenAI) {
			selection.Skipped = append(selection.Skipped, candidate)
			continue
		}
		if s.ModelUnavailable(candidate, config, accountID, now) {
			selection.Skipped = append(selection.Skipped, candidate)
			continue
		}
		selection.Model = candidate
		selection.Rewritten = !slugsEquivalent(candidate, primary)
		return selection
	}
	return selection
}

var quotaFailurePattern = regexp.MustCompile(`(?i)(quota|rate.?limit|too many requests|usage limit|exhausted|429)`)

func (s *SubagentFallbackState) NoteFailure(model, message string, config SubagentFallbackConfig, accountID *string, now time.Time, ttl time.Duration) {
	if !quotaFailurePattern.MatchString(message) {
		return
	}
	if ttl <= 0 {
		ttl = DefaultSubagentModelFallbackPoll
	}
	route, ok := routeFallback(config, model)
	key := fallbackHealthKey(model, resolvedFallbackAccount(config, accountID), ok && isPoolFallbackRoute(route))
	s.mu.Lock()
	s.health[key] = modelHealthEntry{UnavailableUntil: now.Add(ttl), Reason: "quota_exhausted"}
	s.mu.Unlock()
}

func (s *SubagentFallbackState) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.health)
	s.primedAt = time.Time{}
	s.primeDone = nil
	s.primeError = nil
}

// PrimeQuota shares one in-flight refresh. Failures do not advance the TTL and
// are returned to observers; callers may deliberately ignore the error on spawn.
func (s *SubagentFallbackState) PrimeQuota(now time.Time, config SubagentFallbackConfig, prime func(reason string) error) error {
	s.mu.Lock()
	if !s.primedAt.IsZero() && now.Sub(s.primedAt) < fallbackPoll(config) {
		s.mu.Unlock()
		return nil
	}
	if s.primeDone != nil {
		done := s.primeDone
		s.mu.Unlock()
		<-done
		s.mu.Lock()
		err := s.primeError
		s.mu.Unlock()
		return err
	}
	done := make(chan struct{})
	s.primeDone = done
	s.mu.Unlock()
	err := prime("subagent-spawn")
	s.mu.Lock()
	if err == nil {
		s.primedAt = time.Now()
	}
	s.primeError = err
	s.primeDone = nil
	close(done)
	s.mu.Unlock()
	return err
}

func ReadCodexAgentModel(role, codexHome string) string {
	model, _ := readAgentModelFile(filepath.Join(codexHome, "agents", role+".toml"))
	return model
}

func readAgentModelFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	pattern := regexp.MustCompile(`^\s*model\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$`)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		match := pattern.FindStringSubmatch(scanner.Text())
		if match == nil {
			continue
		}
		return parseTOMLQuoted(match[1]), nil
	}
	return "", scanner.Err()
}

func parseTOMLQuoted(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) >= 2 && (raw[0] == '"' && raw[len(raw)-1] == '"' || raw[0] == '\'' && raw[len(raw)-1] == '\'') {
		raw = raw[1 : len(raw)-1]
	}
	return strings.TrimSpace(strings.ReplaceAll(raw, `\"`, `"`))
}

func ReadCodexAgentModelFallback(role, codexHome string) []string {
	models, _ := readAgentFallbackFile(filepath.Join(codexHome, "agents", role+".toml"))
	return models
}

func readAgentFallbackFile(path string) ([]string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	match := regexp.MustCompile(`(?ms)^\s*model_fallback\s*=\s*\[(.*?)\]\s*(?:#.*)?$`).FindSubmatch(content)
	if match == nil {
		return nil, nil
	}
	quoted := regexp.MustCompile(`"((?:\\.|[^"\\])*)"`).FindAllSubmatch(match[1], -1)
	models := make([]string, 0, len(quoted))
	for _, item := range quoted {
		models = append(models, strings.ReplaceAll(string(item[1]), `\"`, `"`))
	}
	return models, nil
}

func ListCodexAgentRoles(codexHome string) []string {
	entries, err := os.ReadDir(filepath.Join(codexHome, "agents"))
	if err != nil {
		return nil
	}
	roles := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".toml") {
			roles = append(roles, strings.TrimSuffix(entry.Name(), ".toml"))
		}
	}
	sort.Strings(roles)
	return roles
}

func ResolveAgentModelFallbackForPrimary(primary, codexHome string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, role := range ListCodexAgentRoles(codexHome) {
		if model := ReadCodexAgentModel(role, codexHome); model == "" || !slugsEquivalent(model, primary) {
			continue
		}
		for _, fallback := range ReadCodexAgentModelFallback(role, codexHome) {
			key := strings.ToLower(strings.TrimSpace(fallback))
			if key != "" && !seen[key] {
				seen[key] = true
				result = append(result, strings.TrimSpace(fallback))
			}
		}
	}
	return result
}

func SubagentFallbackGuidanceText(chain []string) string {
	if len(chain) == 0 {
		return ""
	}
	quoted := make([]string, len(chain))
	for i, model := range chain {
		quoted[i] = fmt.Sprintf("%q", model)
	}
	return " Subagent model fallback chain (priority order): " + strings.Join(quoted, ", ") + ". When the primary model is quota-exhausted, opencodex rewrites thread_spawn requests to the next available model automatically."
}

var errNoFallbackRoute = errors.New("no fallback route")
