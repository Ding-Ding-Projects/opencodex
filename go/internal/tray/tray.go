package tray

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotSupported        = errors.New("system tray is not supported on this platform")
	ErrForeignRegistration = errors.New("refusing to modify a foreign tray startup registration")
)

const DefaultHeartbeatStaleAfter = 15 * time.Second

type State string

type Action string

const (
	StateOnline  State = "online"
	StateWarning State = "warning"
	StateOffline State = "offline"
)

const (
	ActionInstall   Action = "install"
	ActionUninstall Action = "uninstall"
	ActionStart     Action = "start"
	ActionStop      Action = "stop"
	ActionRestart   Action = "restart"
	ActionStatus    Action = "status"
	ActionRun       Action = "run"
)

type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Stale     bool   `json:"stale"`
	State     State  `json:"state"`
	Summary   string `json:"summary"`
}

type Command struct {
	Executable string
	Arguments  []string
}

type Config struct {
	StateDir            string
	Executable          string
	RunArguments        []string
	DashboardURL        string
	HealthURL           string
	StartupHealthURL    string
	RestartCommand      Command
	PollInterval        time.Duration
	HeartbeatInterval   time.Duration
	HeartbeatStaleAfter time.Duration
}

// Handoff records only owned state that may be restored after an executable update.
type Handoff struct {
	Installed bool
	Running   bool
}

// Manager owns one startup registration and its tray process. Implementations must
// never replace or remove a registration unless its persisted command matches.
type Manager interface {
	Install(ctx context.Context, startNow bool) (Status, error)
	Uninstall(ctx context.Context) (Status, error)
	Start(ctx context.Context) (Status, error)
	Stop(ctx context.Context) (Status, error)
	Status(ctx context.Context) (Status, error)
	Run(ctx context.Context) error
	PrepareUpdate(ctx context.Context) (Handoff, error)
	CompleteUpdate(ctx context.Context, handoff Handoff) (Status, error)
}

func New(config Config) (Manager, error) { return newManager(config) }

// ExecuteAction is the canonical tray lifecycle dispatcher shared by CLI and
// management callers. Restart never starts after a failed stop.
func ExecuteAction(ctx context.Context, manager Manager, action Action, startNow bool) (Status, error) {
	if manager == nil {
		return Status{}, errors.New("tray manager is required")
	}
	switch action {
	case ActionInstall:
		return manager.Install(ctx, startNow)
	case ActionUninstall:
		return manager.Uninstall(ctx)
	case ActionStart:
		return manager.Start(ctx)
	case ActionStop:
		return manager.Stop(ctx)
	case ActionRestart:
		if _, err := manager.Stop(ctx); err != nil {
			return Status{}, err
		}
		return manager.Start(ctx)
	case ActionStatus:
		return manager.Status(ctx)
	case ActionRun:
		return Status{}, manager.Run(ctx)
	default:
		return Status{}, errors.New("unknown tray action " + string(action))
	}
}
