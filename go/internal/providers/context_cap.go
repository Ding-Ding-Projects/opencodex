package providers

import "math"

const DefaultProviderContextCap = 350_000

type ContextCapConfig struct {
	ProviderContextCaps map[string]float64
	ContextCapValue     float64
}

func validContextCap(v float64) bool { return v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }
func ProviderContextCap(c ContextCapConfig, provider string) (int, bool) {
	v, ok := c.ProviderContextCaps[provider]
	return int(v), ok && validContextCap(v)
}
func ProviderContextCaps(c ContextCapConfig) map[string]int {
	out := map[string]int{}
	for k, v := range c.ProviderContextCaps {
		if validContextCap(v) {
			out[k] = int(v)
		}
	}
	return out
}
func ApplyProviderContextCap(window, cap int) int {
	if window <= 0 || cap <= 0 {
		return window
	}
	if window > cap {
		return cap
	}
	return window
}
func GlobalContextCapValue(c ContextCapConfig) int {
	if validContextCap(c.ContextCapValue) {
		return int(c.ContextCapValue)
	}
	return DefaultProviderContextCap
}
func SetProviderContextCap(c *ContextCapConfig, provider string, enabled bool) {
	if c == nil {
		return
	}
	next := ProviderContextCaps(*c)
	if enabled {
		next[provider] = GlobalContextCapValue(*c)
	} else {
		delete(next, provider)
	}
	c.ProviderContextCaps = mapIntToFloat(next)
}
func SetGlobalContextCapValue(c *ContextCapConfig, value float64) {
	if c == nil || !validContextCap(value) {
		return
	}
	c.ContextCapValue = float64(int(value))
	for k := range c.ProviderContextCaps {
		c.ProviderContextCaps[k] = c.ContextCapValue
	}
}
func SetAllProviderContextCaps(c *ContextCapConfig, names []string, enabled bool) {
	if c == nil {
		return
	}
	if !enabled {
		c.ProviderContextCaps = nil
		return
	}
	c.ProviderContextCaps = map[string]float64{}
	for _, n := range names {
		c.ProviderContextCaps[n] = float64(GlobalContextCapValue(*c))
	}
	if len(c.ProviderContextCaps) == 0 {
		c.ProviderContextCaps = nil
	}
}
func mapIntToFloat(in map[string]int) map[string]float64 {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]float64, len(in))
	for k, v := range in {
		out[k] = float64(v)
	}
	return out
}
