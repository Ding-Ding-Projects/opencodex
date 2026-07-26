package claude

import (
	"context"
	"strconv"
	"strings"
	"time"
)

const (
	OneMillion               = 1_000_000
	AutoCompactWindowDefault = 350_000
	AutoContextFloor         = 200_000
	AutoCompactWindowMin     = 100_000
	AutoCompactWindowMax     = OneMillion
)

type AutoContextMode struct {
	Enabled       bool
	CompactWindow int
}

var AutoContextOff = AutoContextMode{CompactWindow: AutoCompactWindowDefault}

type ContextConfig struct {
	AutoContext       *bool
	AutoCompactWindow int
	MaxContextTokens  int
}

type ContextModel struct {
	Provider      string
	ID            string
	ContextWindow int
}

type ClaudeTierModels struct {
	Opus   string
	Sonnet string
	Haiku  string
	Fable  string
}

type ModelEnvConfig struct {
	ContextConfig
	Model          string
	SmallFastModel string
	TierModels     ClaudeTierModels
}

func HasOneMillionMarker(s string) bool { return strings.HasSuffix(strings.ToLower(s), "[1m]") }
func StripOneMillionMarker(s string) string {
	if HasOneMillionMarker(s) {
		return s[:len(s)-4]
	}
	return s
}

func ResolveAutoContext(cfg *ContextConfig, envOverride string) AutoContextMode {
	if cfg != nil && cfg.AutoContext != nil && !*cfg.AutoContext {
		return AutoContextOff
	}
	if cfg != nil && cfg.MaxContextTokens > 0 {
		return AutoContextOff
	}
	if envOverride != "" {
		var n int
		if value, err := strconv.Atoi(envOverride); err == nil {
			n = value
		}
		if validCompactWindow(n) {
			return AutoContextMode{true, n}
		}
		return AutoContextOff
	}
	n := AutoCompactWindowDefault
	if cfg != nil && validCompactWindow(cfg.AutoCompactWindow) {
		n = cfg.AutoCompactWindow
	}
	return AutoContextMode{true, n}
}

func validCompactWindow(n int) bool { return n >= AutoCompactWindowMin && n <= AutoCompactWindowMax }

func ShouldMarkOneMillion(window int, auto AutoContextMode) bool {
	return window >= OneMillion || (window > AutoContextFloor && auto.Enabled && window >= auto.CompactWindow)
}

func WithOneMillionMarker(selector string, windows map[string]int, auto AutoContextMode) string {
	if selector == "" || HasOneMillionMarker(selector) {
		return selector
	}
	if ShouldMarkOneMillion(windows[StripOneMillionMarker(selector)], auto) {
		return selector + "[1m]"
	}
	return selector
}

func BuildClaudeContextWindows(native map[string]int, routed []ContextModel) map[string]int {
	out := map[string]int{}
	put := func(k string, n int) {
		if k != "" && n > 0 {
			if _, ok := out[k]; !ok {
				out[k] = n
			}
		}
	}
	for slug, window := range native {
		put(slug, window)
		put(Desktop3pAlias("native", slug), window)
		if a, ok := AliasForNative(slug); ok {
			put(a, window)
		}
	}
	counts := map[string]int{}
	for _, m := range routed {
		counts[m.ID]++
	}
	for _, m := range routed {
		if m.ContextWindow <= 0 || (m.Provider == "anthropic" && m.ContextWindow < OneMillion) {
			continue
		}
		put(m.Provider+"/"+m.ID, m.ContextWindow)
		put(Desktop3pAlias(m.Provider, m.ID), m.ContextWindow)
		if a, ok := AliasForRoute(m.Provider, m.ID); ok {
			put(a, m.ContextWindow)
		}
		if counts[m.ID] == 1 {
			put(m.ID, m.ContextWindow)
		}
	}
	return out
}

func EffectiveModelEnv(cfg *ModelEnvConfig, windows map[string]int, auto *AutoContextMode) map[string]string {
	result := map[string]string{}
	mode := ResolveAutoContext(nil, "")
	if cfg != nil {
		mode = ResolveAutoContext(&cfg.ContextConfig, "")
	}
	if auto != nil {
		mode = *auto
	}
	set := func(name, value string) {
		if marked := WithOneMillionMarker(value, windows, mode); marked != "" {
			result[name] = marked
		}
	}
	if cfg == nil {
		return result
	}
	set("ANTHROPIC_MODEL", cfg.Model)
	set("ANTHROPIC_DEFAULT_OPUS_MODEL", cfg.TierModels.Opus)
	set("ANTHROPIC_DEFAULT_SONNET_MODEL", cfg.TierModels.Sonnet)
	set("ANTHROPIC_DEFAULT_FABLE_MODEL", cfg.TierModels.Fable)
	haiku := cfg.TierModels.Haiku
	if haiku == "" {
		haiku = cfg.SmallFastModel
	}
	set("ANTHROPIC_DEFAULT_HAIKU_MODEL", haiku)
	set("ANTHROPIC_SMALL_FAST_MODEL", haiku)
	return result
}

func BoundedContextWindows(ctx context.Context, timeout time.Duration, acquire func(context.Context) (map[string]int, error)) (map[string]int, bool) {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type result struct {
		windows map[string]int
		err     error
	}
	completed := make(chan result, 1)
	go func() {
		windows, err := acquire(bounded)
		completed <- result{windows, err}
	}()
	select {
	case <-bounded.Done():
		return nil, false
	case value := <-completed:
		return value.windows, value.err == nil
	}
}
