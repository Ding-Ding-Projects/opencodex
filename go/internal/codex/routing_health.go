package codex

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	CodexDefaultQuotaCooldown    = time.Minute
	CodexMaxQuotaCooldown        = 24 * time.Hour
	CodexMaxResetDerivedCooldown = 15 * time.Minute
	CodexQuotaProbeInterval      = 5 * time.Minute
)

var transientSoftAvoidEscalation = [...]time.Duration{
	CodexTransientSoftAvoid,
	2 * time.Minute,
	10 * time.Minute,
	30 * time.Minute,
}

type CooldownSource string

const (
	CooldownRetryAfter   CooldownSource = "retry-after"
	CooldownResetDerived CooldownSource = "reset-derived"
	CooldownDefault      CooldownSource = "default"
)

// ProbeLease identifies the one request admitted through a reset-derived/default cooldown.
type ProbeLease struct {
	ID         string
	Generation int64
}

// UpstreamHealth contains the complete routing state for one Codex account.
type UpstreamHealth struct {
	ConsecutiveFailures  int
	ConsecutiveSuccesses int
	LastFailureStatus    int
	LastFailureAt        int64
	CooldownUntil        int64
	CooldownSince        int64
	CooldownSource       CooldownSource
	CooldownGeneration   int64
	ProbeLeaseID         string
	ProbeLeaseGeneration int64
	LastProbeAt          int64
	SoftAvoidUntil       int64
}

type CodexUpstreamOutcomeClass string

const (
	OutcomeClassSuccess    CodexUpstreamOutcomeClass = "success"
	OutcomeClassCredential CodexUpstreamOutcomeClass = "credential"
	OutcomeClassQuota      CodexUpstreamOutcomeClass = "quota"
	OutcomeClassTransient  CodexUpstreamOutcomeClass = "transient"
	OutcomeClassCaller     CodexUpstreamOutcomeClass = "caller"
	OutcomeClassUnknown    CodexUpstreamOutcomeClass = "unknown"
)

const (
	CodexConnectError = "connect_error"
	CodexTimeout      = "timeout"
)

type CodexUpstreamOutcomeMeta struct {
	RetryAfter   string
	ResetAt      []any
	Now          time.Time
	ThreadID     string
	ProbeLeaseID string
}

func ClassifyCodexUpstreamOutcome(outcome any) CodexUpstreamOutcomeClass {
	if text, ok := outcome.(string); ok {
		if text == CodexConnectError || text == CodexTimeout {
			return OutcomeClassTransient
		}
		return OutcomeClassUnknown
	}
	status, ok := numericStatus(outcome)
	if !ok {
		return OutcomeClassUnknown
	}
	switch {
	case status >= 200 && status < 300:
		return OutcomeClassSuccess
	case status == 401 || status == 403:
		return OutcomeClassCredential
	case status == 429:
		return OutcomeClassQuota
	case status >= 400 && status < 500:
		return OutcomeClassCaller
	case status >= 500 && status < 600:
		return OutcomeClassTransient
	default:
		return OutcomeClassUnknown
	}
}

func numericStatus(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case int32:
		return int(number), true
	case int64:
		return int(number), true
	case float64:
		if finite(number) {
			return int(number), true
		}
	}
	return 0, false
}

func clampCooldown(duration time.Duration) time.Duration {
	if duration < time.Millisecond {
		return time.Millisecond
	}
	if duration > CodexMaxQuotaCooldown {
		return CodexMaxQuotaCooldown
	}
	return duration
}

func ParseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(text, 64); err == nil && !math.IsNaN(seconds) && !math.IsInf(seconds, 0) && seconds > 0 {
		return clampCooldown(time.Duration(math.Ceil(seconds*1000)) * time.Millisecond), true
	}
	timestamp, err := http.ParseTime(text)
	if err != nil {
		return 0, false
	}
	delay := timestamp.Sub(now)
	if delay <= 0 {
		return 0, false
	}
	return clampCooldown(delay), true
}

func ParseResetCooldown(values []any, now time.Time) (time.Duration, bool) {
	var best time.Duration
	for _, value := range values {
		timestamp, ok := resetTimestamp(value)
		if !ok {
			continue
		}
		delay := time.UnixMilli(timestamp).Sub(now)
		if delay <= 0 {
			continue
		}
		delay = clampCooldown(delay)
		if delay > CodexMaxResetDerivedCooldown {
			delay = CodexMaxResetDerivedCooldown
		}
		if best == 0 || delay < best {
			best = delay
		}
	}
	return best, best > 0
}

func resetTimestamp(value any) (int64, bool) {
	var numeric float64
	switch item := value.(type) {
	case int:
		numeric = float64(item)
	case int64:
		numeric = float64(item)
	case float64:
		numeric = item
	case json.Number:
		parsed, err := item.Float64()
		if err != nil {
			return 0, false
		}
		numeric = parsed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(item), 64)
		if err != nil {
			return 0, false
		}
		numeric = parsed
	default:
		return 0, false
	}
	if !finite(numeric) || numeric <= 0 {
		return 0, false
	}
	if numeric < 1_000_000_000_000 {
		numeric *= 1000
	}
	return int64(numeric), true
}

func ComputeQuotaCooldown(meta CodexUpstreamOutcomeMeta) (time.Time, CooldownSource) {
	now := meta.Now
	if now.IsZero() {
		now = time.Now()
	}
	if delay, ok := ParseRetryAfter(meta.RetryAfter, now); ok {
		return now.Add(delay), CooldownRetryAfter
	}
	if delay, ok := ParseResetCooldown(meta.ResetAt, now); ok {
		return now.Add(delay), CooldownResetDerived
	}
	return now.Add(CodexDefaultQuotaCooldown), CooldownDefault
}

func (r *Router) GetCodexUpstreamHealth(accountID string) (UpstreamHealth, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	health, ok := r.health[accountID]
	return health, ok
}

func (r *Router) ClearCodexUpstreamHealth(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if accountID == "" {
		clear(r.health)
	} else {
		delete(r.health, accountID)
	}
}

func (r *Router) cooldownUntilLocked(accountID string, now int64) int64 {
	until := r.health[accountID].CooldownUntil
	if until > now {
		return until
	}
	return 0
}

func (r *Router) softAvoidUntilLocked(accountID string, now int64) int64 {
	until := r.health[accountID].SoftAvoidUntil
	if until > now {
		return until
	}
	return 0
}

func (r *Router) GetCodexAccountCooldownUntil(accountID string, now time.Time) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	until := r.cooldownUntilLocked(accountID, now.UnixMilli())
	return time.UnixMilli(until), until != 0
}

func (r *Router) GetCodexAccountSoftAvoidUntil(accountID string, now time.Time) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	until := r.softAvoidUntilLocked(accountID, now.UnixMilli())
	return time.UnixMilli(until), until != 0
}

func (r *Router) TryAcquireCodexQuotaProbeLease(accountID string, now time.Time) (ProbeLease, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	health, ok := r.health[accountID]
	nowMillis := now.UnixMilli()
	if !ok || health.CooldownUntil <= nowMillis || health.CooldownSource == CooldownRetryAfter || health.ProbeLeaseID != "" {
		return ProbeLease{}, false
	}
	origin := health.LastProbeAt
	if origin == 0 {
		origin = health.CooldownSince
	}
	if origin == 0 {
		origin = health.CooldownUntil
	}
	if nowMillis-origin < CodexQuotaProbeInterval.Milliseconds() {
		return ProbeLease{}, false
	}
	lease := ProbeLease{ID: randomLeaseID(), Generation: health.CooldownGeneration}
	health.ProbeLeaseID = lease.ID
	health.ProbeLeaseGeneration = lease.Generation
	health.LastProbeAt = nowMillis
	r.health[accountID] = health
	return lease, true
}

func randomLeaseID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(value)
}

func (r *Router) ReleaseCodexQuotaProbeLease(accountID, leaseID string, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	health, ok := r.health[accountID]
	if !ok || health.ProbeLeaseID != leaseID {
		return
	}
	r.health[accountID] = releaseProbeLease(health, now.UnixMilli())
}

func releaseProbeLease(health UpstreamHealth, now int64) UpstreamHealth {
	health.ProbeLeaseID = ""
	health.ProbeLeaseGeneration = 0
	health.LastProbeAt = now
	return health
}

func ownsProbeLease(health UpstreamHealth, exists bool, leaseID string) bool {
	return exists && leaseID != "" && leaseID == health.ProbeLeaseID
}

func probeMayClearCooldown(health UpstreamHealth, exists bool, leaseID string) bool {
	return ownsProbeLease(health, exists, leaseID) && health.ProbeLeaseGeneration == health.CooldownGeneration
}
