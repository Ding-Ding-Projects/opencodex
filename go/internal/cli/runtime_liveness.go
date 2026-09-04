package cli

import (
	"context"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/server"
)

func proxyLivenessIO(cfg *config.Config) server.ProxyLivenessIO {
	return server.ProxyLivenessIO{
		ReadPID: func() int {
			pid, _ := readRuntime()
			return pid
		},
		ReadRuntime: func(expectedPID int) *server.ProxyRuntimeRecord {
			pid, port := readRuntime()
			if port <= 0 || expectedPID > 0 && pid != expectedPID {
				return nil
			}
			return &server.ProxyRuntimeRecord{PID: pid, Port: port, Hostname: cfg.Host}
		},
		VerifyPID: platform.ProcessAlive,
		Config: func() (string, int) {
			return cfg.Host, cfg.Port
		},
		Timeout: 750 * time.Millisecond,
	}
}

func findLiveProxy(ctx context.Context, cfg *config.Config) *server.LiveProxy {
	return server.FindLiveProxy(ctx, proxyLivenessIO(cfg))
}
