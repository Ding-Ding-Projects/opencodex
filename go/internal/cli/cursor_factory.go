package cli

import (
	"time"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func newCursorNativeExecutor(provider config.ProviderConfig) (*cursoradapter.NativeExecutor, error) {
	servers := make(map[string]cursoradapter.MCPServerConfig, len(provider.MCPServers))
	for name, server := range provider.MCPServers {
		servers[name] = cursoradapter.MCPServerConfig{
			Command: server.Command, Args: append([]string(nil), server.Args...), Env: cloneStringMap(server.Env),
			WorkingDirectory: server.WorkingDirectory, URL: server.URL, Headers: cloneStringMap(server.Headers),
			Enabled: server.Enabled, ToolPrefix: server.ToolPrefix,
		}
	}
	resolved, err := cursoradapter.ResolveMCPServers(cursoradapter.CursorProviderConfig{MCPServers: servers})
	if err != nil {
		return nil, err
	}
	var dispatcher *cursoradapter.ToolDispatcher
	if len(resolved) > 0 || provider.DesktopExecutor != nil {
		dispatcher = &cursoradapter.ToolDispatcher{}
		if len(resolved) > 0 {
			dispatcher.MCP = cursoradapter.NewMCPManager(resolved, cursoradapter.MCPManagerOptions{})
		}
		if desktop := provider.DesktopExecutor; desktop != nil && (desktop.ComputerUseCommand != "" || desktop.RecordScreenCommand != "") {
			dispatcher.Desktop = &cursoradapter.DesktopExecutor{Config: cursoradapter.DesktopExecutorConfig{
				ComputerUseCommand: desktop.ComputerUseCommand, RecordScreenCommand: desktop.RecordScreenCommand,
				WorkingDirectory: desktop.WorkingDirectory, Env: cloneStringMap(desktop.Env), Timeout: time.Duration(desktop.TimeoutMS) * time.Millisecond,
			}}
		}
	}
	policy := cursoradapter.ExecPolicy{Provider: cursoradapter.ProviderPolicy{
		Mode: cursoradapter.NativeExecMode(provider.NativeLocalExec), LegacyUnsafeAllow: provider.UnsafeAllowNativeLocalExec,
		AllowPrivateNetwork: provider.AllowPrivateNetwork,
	}}
	return cursoradapter.NewNativeExecutor(policy, dispatcher), nil
}
