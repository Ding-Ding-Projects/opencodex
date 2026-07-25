package providers

import (
	"testing"
	"time"
)

func TestKeyFailoverRotatesAndHonorsAttemptedKey(t *testing.T) {
	f := NewKeyFailover()
	now := time.Unix(100, 0)
	p := ProviderConfig{AuthMode: "key", APIKey: "one", APIKeyPool: []APIKeyEntry{{ID: "a", Key: "one"}, {ID: "b", Key: "two"}}}
	got, ok := f.RotateKeyOn429("x", &p, "120", now, "one")
	if !ok || got.APIKey != "two" {
		t.Fatalf("%v %#v", ok, got)
	}
	until, ok := f.CooldownUntil("x", "a", now)
	if !ok || !until.Equal(now.Add(2*time.Minute)) {
		t.Fatal(until)
	}
	got, ok = f.RotateKeyOn429("x", &p, "", now, "one")
	if !ok || got.APIKey != "two" {
		t.Fatal("concurrent loser rotated healthy key")
	}
}
func TestKeyFailoverRejectsOAuthAndSingleKey(t *testing.T) {
	if HasKeyPoolFailover(ProviderConfig{AuthMode: "oauth", APIKeyPool: []APIKeyEntry{{}, {}}}) || HasKeyPoolFailover(ProviderConfig{AuthMode: "key", APIKeyPool: []APIKeyEntry{{}}}) {
		t.Fatal("invalid failover")
	}
}
