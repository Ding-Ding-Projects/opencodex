package openai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestMimoBuildAndDoRetries401OnceWithFreshJWT(t *testing.T) {
	var bootstraps atomic.Int32
	var chats atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bootstrap":
			attempt := bootstraps.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]string{"jwt": "jwt-" + string(rune('0'+attempt))})
		case "/chat":
			attempt := chats.Add(1)
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), MimoSystemMarker) {
				t.Errorf("MiMo marker missing from body: %s", body)
			}
			wantAuth := "Bearer jwt-" + string(rune('0'+attempt))
			if r.Header.Get("Authorization") != wantAuth {
				t.Errorf("attempt %d authorization = %q, want %q", attempt, r.Header.Get("Authorization"), wantAuth)
			}
			if attempt == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewMimoAdapter()
	adapter.Client = server.Client()
	adapter.BootstrapURL = server.URL + "/bootstrap"
	adapter.ChatURL = server.URL + "/chat"
	adapter.ConfigDir = t.TempDir()
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "mimo", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := adapter.Do(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || bootstraps.Load() != 2 || chats.Load() != 2 {
		t.Fatalf("status=%d bootstraps=%d chats=%d", response.StatusCode, bootstraps.Load(), chats.Load())
	}
}

func TestMimoDoDoesNotRetry403(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	adapter := NewMimoAdapter()
	adapter.Client = server.Client()
	response, err := adapter.Do(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden || calls.Load() != 1 {
		t.Fatalf("status=%d calls=%d", response.StatusCode, calls.Load())
	}
}

func TestMimoJWTBootstrapIsSingleflightUnderParallelBuilds(t *testing.T) {
	var bootstraps atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if bootstraps.Add(1) == 1 {
			close(entered)
		}
		<-release
		_ = json.NewEncoder(w).Encode(map[string]string{"jwt": "shared-jwt"})
	}))
	defer server.Close()

	adapter := NewMimoAdapter()
	adapter.Client = server.Client()
	adapter.BootstrapURL = server.URL
	adapter.ChatURL = server.URL + "/chat"
	adapter.ConfigDir = t.TempDir()
	const workers = 24
	start := make(chan struct{})
	results := make(chan error, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
				ModelID: "mimo",
				Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"parallel"`)}}},
			})
			if err == nil {
				if got := request.Header.Get("Authorization"); got != "Bearer shared-jwt" {
					err = errors.New("unexpected shared JWT authorization")
				}
				_ = request.Body.Close()
			}
			results <- err
		}(index)
	}
	close(start)
	<-entered
	close(release)
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := bootstraps.Load(); got != 1 {
		t.Fatalf("bootstrap calls = %d, want 1", got)
	}
}
