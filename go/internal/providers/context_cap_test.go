package providers

import "testing"

func TestContextCaps(t *testing.T) {
	c := ContextCapConfig{ProviderContextCaps: map[string]float64{"ok": 400000, "bad": -1}}
	if got := ProviderContextCaps(c); len(got) != 1 || got["ok"] != 400000 {
		t.Fatal(got)
	}
	SetProviderContextCap(&c, "x", true)
	if c.ProviderContextCaps["x"] != DefaultProviderContextCap {
		t.Fatal(c)
	}
	SetGlobalContextCapValue(&c, 123456.9)
	if c.ProviderContextCaps["x"] != 123456 {
		t.Fatal(c)
	}
	if ApplyProviderContextCap(200000, 100000) != 100000 {
		t.Fatal("cap not applied")
	}
}
