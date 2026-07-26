package cli

import (
	"io"
	"net"
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/server"
)

func TestServeListenerStartsServingBeforePostListenWork(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	httpServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ready")
	})}
	afterStart := func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if requestErr != nil {
			t.Errorf("post-listen request failed: %v", requestErr)
		} else {
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Errorf("post-listen status=%d", response.StatusCode)
			}
		}
		close(stop)
	}
	if err := serveListener(httpServer, server.NewLifecycle(), listener, stop, afterStart); err != nil {
		t.Fatal(err)
	}
}
