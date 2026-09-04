package lib

import (
	"os"
	"sync"
)

type DebugFlag string

const (
	DebugProvider  DebugFlag = "debug"
	DebugUsage     DebugFlag = "usage"
	DebugInjection DebugFlag = "injection"
	DebugClaude    DebugFlag = "claude"
)

var debugEnv = map[DebugFlag]string{DebugProvider: "OCX_DEBUG", DebugUsage: "OPENCODEX_USAGE_DEBUG", DebugInjection: "OCX_INJECTION_DEBUG", DebugClaude: "OCX_CLAUDE_DEBUG"}

type DebugSettingsView struct {
	Enabled, Usage, Injection, Claude bool
	RuntimeOverride                   map[DebugFlag]bool
	Env                               map[DebugFlag]bool
}

var debugSettings = struct {
	sync.RWMutex
	values map[DebugFlag]bool
	set    map[DebugFlag]bool
}{values: map[DebugFlag]bool{}, set: map[DebugFlag]bool{}}

func debugEnabled(flag DebugFlag) bool {
	debugSettings.RLock()
	v, set := debugSettings.values[flag], debugSettings.set[flag]
	debugSettings.RUnlock()
	if set {
		return v
	}
	if flag == DebugProvider && os.Getenv("OCX_DEBUG_FRAMES") == "1" {
		return true
	}
	return os.Getenv(debugEnv[flag]) == "1"
}
func IsDebugEnabled() bool          { return debugEnabled(DebugProvider) }
func IsUsageDebugEnabled() bool     { return debugEnabled(DebugUsage) }
func IsInjectionDebugEnabled() bool { return debugEnabled(DebugInjection) }
func IsClaudeDebugEnabled() bool    { return debugEnabled(DebugClaude) }
func GetDebugSettings() DebugSettingsView {
	debugSettings.RLock()
	overrides := map[DebugFlag]bool{}
	for k := range debugSettings.set {
		overrides[k] = debugSettings.values[k]
	}
	debugSettings.RUnlock()
	env := map[DebugFlag]bool{}
	for k, n := range debugEnv {
		env[k] = os.Getenv(n) == "1"
	}
	env[DebugProvider] = env[DebugProvider] || os.Getenv("OCX_DEBUG_FRAMES") == "1"
	return DebugSettingsView{Enabled: IsDebugEnabled(), Usage: IsUsageDebugEnabled(), Injection: IsInjectionDebugEnabled(), Claude: IsClaudeDebugEnabled(), RuntimeOverride: overrides, Env: env}
}
func SetDebugSettings(values map[DebugFlag]bool) DebugSettingsView {
	debugSettings.Lock()
	for k, v := range values {
		if _, ok := debugEnv[k]; ok {
			debugSettings.values[k] = v
			debugSettings.set[k] = true
		}
	}
	debugSettings.Unlock()
	return GetDebugSettings()
}
func ClearDebugSetting(flag DebugFlag) DebugSettingsView {
	debugSettings.Lock()
	delete(debugSettings.values, flag)
	delete(debugSettings.set, flag)
	debugSettings.Unlock()
	return GetDebugSettings()
}
func ClearDebugSettings() DebugSettingsView {
	debugSettings.Lock()
	debugSettings.values = map[DebugFlag]bool{}
	debugSettings.set = map[DebugFlag]bool{}
	debugSettings.Unlock()
	return GetDebugSettings()
}
