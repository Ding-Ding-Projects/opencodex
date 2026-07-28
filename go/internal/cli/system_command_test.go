package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func runSystemWith(t *testing.T, server *httptest.Server, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := systemDispatch(context.Background(), testAPI(server), args, IO{Out: &out})
	return out.String(), err
}

// Each subcommand must reach its own route with its own method.
func TestSystemSubcommandsUseTheirOwnRoutes(t *testing.T) {
	for _, testCase := range []struct {
		args   []string
		method string
		path   string
	}{
		{args: []string{"settings"}, method: http.MethodGet, path: "/api/settings"},
		{args: []string{"startup"}, method: http.MethodGet, path: "/api/startup-health"},
		{args: []string{"startup", "health"}, method: http.MethodGet, path: "/api/startup-health"},
		{args: []string{"diagnostics"}, method: http.MethodGet, path: "/api/diagnostics/project-config"},
		{args: []string{"sync"}, method: http.MethodPost, path: "/api/sync"},
		{args: []string{"update", "check"}, method: http.MethodGet, path: "/api/update/check?tag=latest"},
		{args: []string{"update", "status", "job-1"}, method: http.MethodGet, path: "/api/update/status?jobId=job-1"},
	} {
		t.Run(strings.Join(testCase.args, " "), func(t *testing.T) {
			server, calls := grokServer(t, `{}`)
			if _, err := runSystemWith(t, server, testCase.args...); err != nil {
				t.Fatal(err)
			}
			if len(*calls) != 1 {
				t.Fatalf("calls = %d, want 1", len(*calls))
			}
			if (*calls)[0].method != testCase.method || (*calls)[0].path != testCase.path {
				t.Fatalf("call = %s %s, want %s %s",
					(*calls)[0].method, (*calls)[0].path, testCase.method, testCase.path)
			}
		})
	}
}

// settings reads with no flags and WRITES with any. Treating it as read-only
// would silently drop the only path that changes these values.
func TestSystemSettingsReadsOrWrites(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "settings"); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].method != http.MethodGet {
		t.Fatalf("bare settings should read, got %s", (*calls)[0].method)
	}

	server, calls = grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "settings", "--auto-start", "on", "--stream-mode", "eager-relay"); err != nil {
		t.Fatal(err)
	}
	put := (*calls)[0]
	if put.method != http.MethodPut || put.path != "/api/settings" {
		t.Fatalf("call = %s %s", put.method, put.path)
	}
	if put.body["codexAutoStart"] != true {
		t.Fatalf("codexAutoStart = %#v", put.body["codexAutoStart"])
	}
	if put.body["streamMode"] != "eager-relay" {
		t.Fatalf("streamMode = %#v", put.body["streamMode"])
	}
}

func TestSystemStartupInstallActions(t *testing.T) {
	for _, action := range []string{"install-service", "install-shim"} {
		server, calls := grokServer(t, `{}`)
		if _, err := runSystemWith(t, server, "startup", action); err != nil {
			t.Fatal(err)
		}
		post := (*calls)[0]
		if post.method != http.MethodPost || post.path != "/api/startup-action" {
			t.Fatalf("call = %s %s", post.method, post.path)
		}
		if post.body["action"] != action {
			t.Fatalf("action = %#v, want %q", post.body["action"], action)
		}
	}
	server, calls := grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "startup", "bogus"); err == nil {
		t.Fatal("expected an unknown startup action to be rejected")
	}
	if len(*calls) != 0 {
		t.Fatal("an unknown action must not reach the network")
	}
}

// An update is destructive enough to require confirmation, and --restart
// defaults to true, so omitting it still restarts.
func TestSystemUpdateRunRequiresConfirmationAndDefaultsRestart(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "update", "run"); err == nil {
		t.Fatal("expected update run to require --yes")
	}
	if len(*calls) != 0 {
		t.Fatal("an unconfirmed update must not reach the network")
	}

	server, calls = grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "update", "run", "--channel", "preview", "--yes"); err != nil {
		t.Fatal(err)
	}
	post := (*calls)[0]
	if post.path != "/api/update/run" || post.method != http.MethodPost {
		t.Fatalf("call = %s %s", post.method, post.path)
	}
	// --channel is renamed to tag on the wire.
	if post.body["tag"] != "preview" {
		t.Fatalf("tag = %#v, want preview", post.body["tag"])
	}
	if post.body["restart"] != true {
		t.Fatalf("restart = %#v, want the default true", post.body["restart"])
	}

	server, calls = grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "update", "run", "--restart", "off", "--yes"); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].body["restart"] != false {
		t.Fatalf("restart = %#v, want false", (*calls)[0].body["restart"])
	}
}

func TestSystemUpdateValidatesChannelAndJobID(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	for _, args := range [][]string{
		{"update", "check", "--channel", "nightly"},
		{"update", "run", "--channel", "nightly", "--yes"},
		{"update", "status"},
		{"bogus"},
	} {
		if _, err := runSystemWith(t, server, args...); err == nil {
			t.Fatalf("expected %v to be rejected", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("validation must precede the request, got %+v", *calls)
	}
}

// A job id is a user-supplied string, so it must be escaped like the oracle.
func TestSystemUpdateStatusEscapesJobID(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runSystemWith(t, server, "update", "status", "a b/c"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*calls)[0].path, "jobId=a%20b%2Fc") {
		t.Fatalf("path = %q, want an encodeURIComponent-escaped id", (*calls)[0].path)
	}
}

func TestSystemStatusReadsEverySurface(t *testing.T) {
	server, calls := grokServer(t, `{}`)
	if _, err := runSystemWith(t, server); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, call := range *calls {
		seen[call.path] = true
	}
	for _, path := range []string{"/api/settings", "/api/startup-health", "/api/system/memory"} {
		if !seen[path] {
			t.Fatalf("status did not read %s", path)
		}
	}
}
