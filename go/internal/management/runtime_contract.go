package management

import "context"

type ProviderQuotaWindow struct {
	Label   string  `json:"label"`
	Percent float64 `json:"percent"`
	ResetAt *int64  `json:"resetAt,omitempty"`
}
type ProviderQuota struct {
	FiveHourPercent *float64              `json:"fiveHourPercent,omitempty"`
	FiveHourResetAt *int64                `json:"fiveHourResetAt,omitempty"`
	WeeklyPercent   *float64              `json:"weeklyPercent,omitempty"`
	WeeklyResetAt   *int64                `json:"weeklyResetAt,omitempty"`
	MonthlyPercent  *float64              `json:"monthlyPercent,omitempty"`
	MonthlyResetAt  *int64                `json:"monthlyResetAt,omitempty"`
	CustomWindows   []ProviderQuotaWindow `json:"customWindows,omitempty"`
	UpdatedAt       int64                 `json:"updatedAt"`
}
type ProviderQuotaReport struct {
	Provider          string        `json:"provider"`
	Label             string        `json:"label"`
	Source            string        `json:"source"`
	Quota             ProviderQuota `json:"quota"`
	UpdatedAt         int64         `json:"updatedAt"`
	ReverseEngineered bool          `json:"reverseEngineered,omitempty"`
}
type ProviderQuotaResponse struct {
	GeneratedAt int64                 `json:"generatedAt"`
	Reports     []ProviderQuotaReport `json:"reports"`
}

type ProviderQuotaBackend interface {
	ProviderQuotas(context.Context, bool) (ProviderQuotaResponse, error)
}

// ClaudeCodeRuntime applies operating-system integration after configuration is
// safely persisted. The CLI implementation owns launchd/system environment and
// generated Claude agent definition I/O.
type ClaudeCodeRuntime interface {
	ApplyClaudeCodeSystemEnv(context.Context) error
	SyncClaudeAgentDefinitions(context.Context) error
}
