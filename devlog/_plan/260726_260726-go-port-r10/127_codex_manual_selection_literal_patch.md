# 127 — Literal patch: immediate Codex manual selection

Apply this exact independently audited candidate against
`1934ae8b0b6d6e36183cbb83c907152cf0e3b9aa`.

```diff
diff --git a/go/internal/cli/account.go b/go/internal/cli/account.go
index 9a21c588..c6740b76 100644
--- a/go/internal/cli/account.go
+++ b/go/internal/cli/account.go
@@ -363,6 +363,9 @@ func printAccountRows(writer io.Writer, rows []accountRow) {
 		status := ""
 		if row.Active {
 			status = "active"
+			if row.Provider == "openai" {
+				status = "selected"
+			}
 		}
 		if row.NeedsReauth {
 			status = strings.TrimSpace(status + " needs-reauth")
diff --git a/go/internal/cli/account_test.go b/go/internal/cli/account_test.go
index a95bf7b2..dc75f80e 100644
--- a/go/internal/cli/account_test.go
+++ b/go/internal/cli/account_test.go
@@ -70,6 +70,21 @@ func TestAccountListCurrentUseAndConfirmedRemove(t *testing.T) {
 	}
 }
 
+func TestAccountRowsLabelSelectedCodexAccount(t *testing.T) {
+	var output bytes.Buffer
+	printAccountRows(&output, []accountRow{
+		{Provider: "openai", ID: "codex", Active: true},
+		{Provider: "kimi", ID: "oauth", Active: true},
+	})
+	text := output.String()
+	if !strings.Contains(text, "codex         -                         selected") {
+		t.Fatalf("Codex selection label missing: %q", text)
+	}
+	if !strings.Contains(text, "oauth         -                         active") {
+		t.Fatalf("OAuth active label changed: %q", text)
+	}
+}
+
 func TestAccountAutoSwitchPersistsValidatedThreshold(t *testing.T) {
 	home := t.TempDir()
 	t.Setenv("OPENCODEX_HOME", home)
diff --git a/go/internal/cli/codex_routing_production_test.go b/go/internal/cli/codex_routing_production_test.go
index ba201693..90ca30af 100644
--- a/go/internal/cli/codex_routing_production_test.go
+++ b/go/internal/cli/codex_routing_production_test.go
@@ -171,6 +171,12 @@ func TestCanonicalRoutingReplacesQuotaImageAndPreservesProbeProvenance(t *testin
 	}
 	quota.Clear("b")
 	quota.Update("a", 20, nil, nil, nil, nil)
+	if err := auth.persistence.Update(func(live *config.Config) {
+		live.ActiveCodexAccountID = "a"
+		live.AutoSwitchThreshold = 10
+	}); err != nil {
+		t.Fatal(err)
+	}
 	selected, err = auth.ResolveAuth(context.Background(), "openai", "quota-after-clear")
 	if err != nil || selected.AccountID != "a" {
 		t.Fatalf("replaced quota selection=%#v err=%v", selected, err)
diff --git a/go/internal/codex/routing_outcome.go b/go/internal/codex/routing_outcome.go
index c07c96e7..fee32ad4 100644
--- a/go/internal/codex/routing_outcome.go
+++ b/go/internal/codex/routing_outcome.go
@@ -11,6 +11,24 @@ func cooldownOnly(health UpstreamHealth) UpstreamHealth {
 	}
 }
 
+// ResetCodexRoutingForManualSelection discards transient routing evidence
+// without bypassing a real quota cooldown or its probe state.
+func (r *Router) ResetCodexRoutingForManualSelection(accountID string) {
+	r.mu.Lock()
+	defer r.mu.Unlock()
+	clear(r.threadAccounts)
+	current, exists := r.health[accountID]
+	if !exists {
+		return
+	}
+	preserved := cooldownOnly(current)
+	if preserved == (UpstreamHealth{}) {
+		delete(r.health, accountID)
+		return
+	}
+	r.health[accountID] = preserved
+}
+
 func (r *Router) RecordCodexUpstreamOutcome(config *RoutingConfig, accountID string, outcome any, meta CodexUpstreamOutcomeMeta) {
 	if accountID == "" {
 		return
@@ -96,17 +114,19 @@ func (r *Router) RecordCodexUpstreamOutcome(config *RoutingConfig, accountID str
 	if stale {
 		failures = 1
 	}
-	escalation := transientSoftAvoidEscalation[min(failures, len(transientSoftAvoidEscalation))-1]
+	failoverThreshold := failoverThresholdOrDefault(config.UpstreamFailoverThreshold)
+	failoverReady := failoverThreshold > 0 && failures >= failoverThreshold
+	escalationIndex := min(max(failures-failoverThreshold, 0), len(transientSoftAvoidEscalation)-1)
+	escalation := transientSoftAvoidEscalation[escalationIndex]
 	next := cooldownOnly(base)
 	next.ConsecutiveFailures = failures
 	next.LastFailureStatus = status
 	next.LastFailureAt = nowMillis
-	failoverEnabled := failoverThresholdOrDefault(config.UpstreamFailoverThreshold) > 0
-	if failoverEnabled {
+	if failoverReady {
 		next.SoftAvoidUntil = max(r.softAvoidUntilLocked(accountID, nowMillis), nowMillis+escalation.Milliseconds())
 	}
 	r.health[accountID] = next
-	if failoverEnabled && meta.ThreadID != "" {
+	if failoverReady && meta.ThreadID != "" {
 		if bound, ok := r.threadAccounts[meta.ThreadID]; ok && bound.accountID == accountID {
 			delete(r.threadAccounts, meta.ThreadID)
 		}
diff --git a/go/internal/codex/routing_port_test.go b/go/internal/codex/routing_port_test.go
index 94ac8947..89a7c4af 100644
--- a/go/internal/codex/routing_port_test.go
+++ b/go/internal/codex/routing_port_test.go
@@ -36,6 +36,29 @@ func TestComputeCodexUsageScorePlanSemantics(t *testing.T) {
 	}
 }
 
+func TestUnknownUsagePreservesExplicitSelectionAcrossRoutingPaths(t *testing.T) {
+	now := time.UnixMilli(1_700_000_000_000)
+	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
+	config.ActiveCodexAccountID = "a"
+	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(20)})
+
+	if got := router.ResolveCodexAccountForThread("apply", config, now); got != "a" {
+		t.Fatalf("apply selected %q", got)
+	}
+	if got := router.PreviewCodexAccountForRequest("preview", config, now); got != "a" {
+		t.Fatalf("preview selected %q", got)
+	}
+	if got := router.ResolveCodexAccountForThread("affinity", config, now); got != "a" {
+		t.Fatalf("affinity selected %q", got)
+	}
+	if got := router.ResolveCodexAccountForThread("affinity", config, now.Add(CodexThreadAffinityReevalInterval)); got != "a" {
+		t.Fatalf("affinity reevaluation selected %q", got)
+	}
+	if config.ActiveCodexAccountID != "a" {
+		t.Fatalf("active account changed to %q", config.ActiveCodexAccountID)
+	}
+}
+
 func TestQuotaCooldownParsingAndProbeLeaseRecovery(t *testing.T) {
 	now := time.UnixMilli(1_700_000_000_000)
 	if delay, ok := ParseRetryAfter("0.001", now); !ok || delay != time.Millisecond {
@@ -94,16 +117,30 @@ func TestTransientSoftAvoidEscalationAndRecovery(t *testing.T) {
 	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
 	config.ActiveCodexAccountID = "a"
 	config.UpstreamFailoverThreshold = intPointer(3)
-	for index := 0; index < 3; index++ {
-		router.RecordCodexUpstreamOutcome(config, "a", 503, CodexUpstreamOutcomeMeta{Now: now.Add(time.Duration(index) * time.Millisecond)})
+	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "a" {
+		t.Fatalf("initial affinity = %q", got)
 	}
+	for index := 0; index < 2; index++ {
+		at := now.Add(time.Duration(index) * time.Millisecond)
+		router.RecordCodexUpstreamOutcome(config, "a", 503, CodexUpstreamOutcomeMeta{Now: at, ThreadID: "thread"})
+		if _, avoided := router.GetCodexAccountSoftAvoidUntil("a", at); avoided {
+			t.Fatalf("failure %d soft-avoided before threshold", index+1)
+		}
+		if got := router.ResolveCodexAccountForThread("thread", config, at); got != "a" {
+			t.Fatalf("failure %d cleared affinity early: %q", index+1, got)
+		}
+	}
+	router.RecordCodexUpstreamOutcome(config, "a", 503, CodexUpstreamOutcomeMeta{Now: now.Add(2 * time.Millisecond), ThreadID: "thread"})
 	health, _ := router.GetCodexUpstreamHealth("a")
-	if health.ConsecutiveFailures != 3 || health.SoftAvoidUntil != now.Add(10*time.Minute+2*time.Millisecond).UnixMilli() {
+	if health.ConsecutiveFailures != 3 || health.SoftAvoidUntil != now.Add(CodexTransientSoftAvoid+2*time.Millisecond).UnixMilli() {
 		t.Fatalf("escalated health = %#v", health)
 	}
 	if config.ActiveCodexAccountID != "b" {
 		t.Fatalf("active account did not fail over: %q", config.ActiveCodexAccountID)
 	}
+	if got := router.ResolveCodexAccountForThread("thread", config, now.Add(3*time.Millisecond)); got != "b" {
+		t.Fatalf("threshold did not clear affinity: %q", got)
+	}
 	router.RecordCodexUpstreamOutcome(config, "a", 200, CodexUpstreamOutcomeMeta{Now: now.Add(time.Second)})
 	health, exists := router.GetCodexUpstreamHealth("a")
 	if !exists || health.ConsecutiveSuccesses != 1 {
@@ -115,6 +152,55 @@ func TestTransientSoftAvoidEscalationAndRecovery(t *testing.T) {
 	}
 }
 
+func TestTransientFailoverDisabledKeepsAffinityAndSoftAvoidEmpty(t *testing.T) {
+	now := time.UnixMilli(1_700_000_000_000)
+	router, config, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
+	config.ActiveCodexAccountID = "a"
+	config.UpstreamFailoverThreshold = intPointer(0)
+	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "a" {
+		t.Fatalf("initial affinity = %q", got)
+	}
+	for index := 0; index < 5; index++ {
+		at := now.Add(time.Duration(index) * time.Millisecond)
+		router.RecordCodexUpstreamOutcome(config, "a", 503, CodexUpstreamOutcomeMeta{Now: at, ThreadID: "thread"})
+		if _, avoided := router.GetCodexAccountSoftAvoidUntil("a", at); avoided {
+			t.Fatalf("failure %d soft-avoided with failover disabled", index+1)
+		}
+		if got := router.ResolveCodexAccountForThread("thread", config, at); got != "a" {
+			t.Fatalf("failure %d changed affinity: %q", index+1, got)
+		}
+	}
+	if health, found := router.GetCodexUpstreamHealth("a"); !found || health.ConsecutiveFailures != 5 {
+		t.Fatalf("disabled failover health=%#v found=%t", health, found)
+	}
+}
+
+func TestManualSelectionClearsAffinityAndTransientHealthButPreservesCooldownProbe(t *testing.T) {
+	router, _, _ := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
+	router.threadAccounts["a-thread"] = threadAffinityEntry{accountID: "a", generation: 1}
+	router.threadAccounts["b-thread"] = threadAffinityEntry{accountID: "b", generation: 2}
+	want := UpstreamHealth{
+		CooldownUntil: 1_700_000_120_000, CooldownSince: 1_700_000_000_000,
+		CooldownSource: CooldownResetDerived, CooldownGeneration: 4,
+		ProbeLeaseID: "probe", ProbeLeaseGeneration: 4, LastProbeAt: 1_700_000_060_000,
+	}
+	router.health["b"] = UpstreamHealth{
+		ConsecutiveFailures: 4, ConsecutiveSuccesses: 1, LastFailureStatus: 503,
+		LastFailureAt: 1_700_000_003_000, SoftAvoidUntil: 1_700_000_030_000,
+		CooldownUntil: want.CooldownUntil, CooldownSince: want.CooldownSince,
+		CooldownSource: want.CooldownSource, CooldownGeneration: want.CooldownGeneration,
+		ProbeLeaseID: want.ProbeLeaseID, ProbeLeaseGeneration: want.ProbeLeaseGeneration, LastProbeAt: want.LastProbeAt,
+	}
+
+	router.ResetCodexRoutingForManualSelection("b")
+	if len(router.threadAccounts) != 0 {
+		t.Fatalf("thread affinities remained: %#v", router.threadAccounts)
+	}
+	if got, exists := router.GetCodexUpstreamHealth("b"); !exists || got != want {
+		t.Fatalf("preserved health = %#v, exists=%t", got, exists)
+	}
+}
+
 func TestThreadAffinityGenerationTTLAndQuotaReevaluation(t *testing.T) {
 	now := time.UnixMilli(1_700_000_000_000)
 	router, config, store := newRoutingFixture(t, CodexAccount{ID: "a"}, CodexAccount{ID: "b"})
diff --git a/go/internal/codex/routing_selection.go b/go/internal/codex/routing_selection.go
index da2ce9b6..e133afc4 100644
--- a/go/internal/codex/routing_selection.go
+++ b/go/internal/codex/routing_selection.go
@@ -16,6 +16,10 @@ func failoverThresholdOrDefault(value *int) int {
 	return *value
 }
 
+func isUnknownUsage(usage float64) bool {
+	return usage >= CodexUnknownUsageScore
+}
+
 func (r *Router) hasConfiguredPoolAccountLocked(config *RoutingConfig, accountID string, now int64) bool {
 	if accountID == MainCodexAccountID {
 		return r.isUsableLocked(config, accountID, now)
@@ -55,6 +59,9 @@ func (r *Router) applyQuotaAutoSwitchLocked(config *RoutingConfig, active string
 		pointer = &quota
 	}
 	usage := ComputeCodexUsageScore(pointer, r.accountPlanLocked(config, active))
+	if isUnknownUsage(usage) {
+		return active
+	}
 	if usage < threshold {
 		return active
 	}
@@ -62,19 +69,6 @@ func (r *Router) applyQuotaAutoSwitchLocked(config *RoutingConfig, active string
 		r.setActiveLocked(config, best)
 		return best
 	}
-	if usage >= CodexUnknownUsageScore {
-		for _, accountID := range r.eligibleAccountsLocked(config, active, now) {
-			candidate, found := r.quotas[accountID]
-			var candidatePointer *AccountQuota
-			if found {
-				candidatePointer = &candidate
-			}
-			if ComputeCodexUsageScore(candidatePointer, r.accountPlanLocked(config, accountID)) >= CodexUnknownUsageScore {
-				r.setActiveLocked(config, accountID)
-				return accountID
-			}
-		}
-	}
 	return active
 }
 
@@ -129,7 +123,7 @@ func (r *Router) PreviewCodexAccountForRequest(threadID string, config *RoutingC
 					quotaPointer = &quota
 				}
 				usage := ComputeCodexUsageScore(quotaPointer, r.accountPlanLocked(config, entry.accountID))
-				if usage >= threshold {
+				if !isUnknownUsage(usage) && usage >= threshold {
 					if best := r.pickLowerUsageLocked(config, entry.accountID, usage, nowMillis); best != entry.accountID {
 						return best
 					}
@@ -159,7 +153,7 @@ func (r *Router) PreviewCodexAccountForRequest(threadID string, config *RoutingC
 			quotaPointer = &quota
 		}
 		usage := ComputeCodexUsageScore(quotaPointer, r.accountPlanLocked(config, active))
-		if usage >= threshold {
+		if !isUnknownUsage(usage) && usage >= threshold {
 			active = r.pickLowerUsageLocked(config, active, usage, nowMillis)
 		}
 	}
@@ -200,7 +194,7 @@ func (r *Router) ResolveCodexAccountForThreadDetailed(threadID string, config *R
 							pointer = &quota
 						}
 						usage := ComputeCodexUsageScore(pointer, r.accountPlanLocked(config, entry.accountID))
-						if usage >= threshold {
+						if !isUnknownUsage(usage) && usage >= threshold {
 							if best := r.pickLowerUsageLocked(config, entry.accountID, usage, nowMillis); best != entry.accountID {
 								r.setActiveLocked(config, best)
 								r.bindThreadLocked(threadID, best, nowMillis)
diff --git a/go/internal/management/codex_auth.go b/go/internal/management/codex_auth.go
index 3b0a92da..a9e357e9 100644
--- a/go/internal/management/codex_auth.go
+++ b/go/internal/management/codex_auth.go
@@ -220,7 +220,14 @@ func (a *API) putActiveCodexAccount(w http.ResponseWriter, r *http.Request) {
 		writeError(w, http.StatusInternalServerError, "save active Codex account failed")
 		return
 	}
-	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "activeCodexAccountId", value: nullable(active)}})
+	selected := active
+	if selected == "" {
+		selected = codex.MainCodexAccountID
+	}
+	if a.codexRouter != nil {
+		a.codexRouter.ResetCodexRoutingForManualSelection(selected)
+	}
+	writeJSON(w, http.StatusOK, orderedJSONObject{{name: "ok", value: true}, {name: "activeCodexAccountId", value: nullable(active)}, {name: "appliesImmediately", value: true}})
 }
 
 func (a *API) putCodexThreshold(w http.ResponseWriter, r *http.Request, autoSwitch bool) {
diff --git a/go/internal/server/codex_manual_selection_production_test.go b/go/internal/server/codex_manual_selection_production_test.go
new file mode 100644
index 00000000..4bc7f9ff
--- /dev/null
+++ b/go/internal/server/codex_manual_selection_production_test.go
@@ -0,0 +1,74 @@
+package server
+
+import (
+	"net/http"
+	"path/filepath"
+	"testing"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
+)
+
+func TestProductionCodexManualSelectionResetsSharedRouterImmediately(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := appconfig.Default()
+	cfg.CodexAccounts = []appconfig.CodexAccount{{ID: "work", Email: "work@example.test"}}
+	if err := appconfig.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	router := codex.NewRouter(nil, nil)
+	threshold := 3
+	routing := &codex.RoutingConfig{ActiveCodexAccountID: "work", UpstreamFailoverThreshold: &threshold}
+	for index := 0; index < 3; index++ {
+		router.RecordCodexUpstreamOutcome(routing, "work", 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_000 + int64(index))})
+	}
+
+	proxy := New(Config{ManagementConfig: &cfg, ConfigPath: path, CodexRouter: router})
+	defer proxy.Close()
+	response := managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":"work"}`)
+	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"activeCodexAccountId":"work","appliesImmediately":true}` {
+		t.Fatalf("selection = %d %s", response.Code, response.Body.String())
+	}
+	if _, exists := router.GetCodexUpstreamHealth("work"); exists {
+		t.Fatal("production management route did not reset the shared router")
+	}
+	loaded, err := appconfig.Load(path)
+	if err != nil || loaded.ActiveCodexAccountID != "work" {
+		t.Fatalf("persisted selection = %q, error=%v", loaded.ActiveCodexAccountID, err)
+	}
+
+	mainRouting := &codex.RoutingConfig{ActiveCodexAccountID: codex.MainCodexAccountID, UpstreamFailoverThreshold: &threshold}
+	router.RecordCodexUpstreamOutcome(mainRouting, codex.MainCodexAccountID, 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_100)})
+	response = managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":null}`)
+	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true,"activeCodexAccountId":null,"appliesImmediately":true}` {
+		t.Fatalf("main selection = %d %s", response.Code, response.Body.String())
+	}
+	if _, exists := router.GetCodexUpstreamHealth(codex.MainCodexAccountID); exists {
+		t.Fatal("null selection did not reset main router state")
+	}
+	loaded, err = appconfig.Load(path)
+	if err != nil || loaded.ActiveCodexAccountID != "" {
+		t.Fatalf("persisted main selection = %q, error=%v", loaded.ActiveCodexAccountID, err)
+	}
+}
+
+func TestProductionCodexManualSelectionDoesNotResetRouterWhenPersistenceFails(t *testing.T) {
+	cfg := appconfig.Default()
+	cfg.CodexAccounts = []appconfig.CodexAccount{{ID: "work", Email: "work@example.test"}}
+	router := codex.NewRouter(nil, nil)
+	threshold := 1
+	routing := &codex.RoutingConfig{ActiveCodexAccountID: "work", UpstreamFailoverThreshold: &threshold}
+	router.RecordCodexUpstreamOutcome(routing, "work", 503, codex.CodexUpstreamOutcomeMeta{Now: time.UnixMilli(1_700_000_000_000)})
+
+	// A directory cannot be replaced by the atomic config writer.
+	proxy := New(Config{ManagementConfig: &cfg, ConfigPath: t.TempDir(), CodexRouter: router})
+	defer proxy.Close()
+	response := managementRequest(t, proxy.Handler(), http.MethodPut, "/api/codex-auth/active", `{"accountId":"work"}`)
+	if response.Code != http.StatusInternalServerError || cfg.ActiveCodexAccountID != "" {
+		t.Fatalf("failed selection = %d %s active=%q", response.Code, response.Body.String(), cfg.ActiveCodexAccountID)
+	}
+	if health, exists := router.GetCodexUpstreamHealth("work"); !exists || health.ConsecutiveFailures != 1 {
+		t.Fatalf("failed persistence reset router: health=%#v exists=%t", health, exists)
+	}
+}
```

