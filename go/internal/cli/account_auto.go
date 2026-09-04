package cli

import (
	"fmt"
	"strconv"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func accountAutoSwitch(args []string, streams IO) error {
	jsonOutput, rest := consumeBoolFlag(args, "--json")
	if len(rest) < 2 || len(rest) > 3 {
		return fmt.Errorf("usage: ocx account auto-switch openai <on|off|status|threshold 0-100> [--json]")
	}
	if normalizeAccountProvider(rest[0]) != "openai" {
		return fmt.Errorf("auto-switch only applies to the openai Codex account pool")
	}
	cfg, path, err := loadConfig()
	if err != nil {
		return err
	}
	threshold := cfg.AutoSwitchThreshold
	switch rest[1] {
	case "status":
		if len(rest) != 2 {
			return fmt.Errorf("status does not accept a threshold")
		}
	case "on":
		if len(rest) != 2 {
			return fmt.Errorf("on does not accept a threshold; use threshold <0-100>")
		}
		threshold = 80
	case "off":
		if len(rest) != 2 {
			return fmt.Errorf("off does not accept a threshold")
		}
		threshold = 0
	case "threshold":
		if len(rest) != 3 {
			return fmt.Errorf("threshold requires an integer from 0 to 100")
		}
		threshold, err = strconv.Atoi(rest[2])
		if err != nil || threshold < 0 || threshold > 100 {
			return fmt.Errorf("threshold must be an integer from 0 to 100")
		}
	default:
		return fmt.Errorf("unknown auto-switch action %q", rest[1])
	}
	if rest[1] != "status" {
		cfg.AutoSwitchThreshold = threshold
		if err := config.Save(path, cfg); err != nil {
			return err
		}
	}
	enabled := threshold > 0
	if jsonOutput {
		return writePrettyJSON(streams.Out, map[string]any{"provider": "openai", "autoSwitchThreshold": threshold, "enabled": enabled})
	}
	if enabled {
		fmt.Fprintf(streams.Out, "auto-switch: on (threshold %d%%)\n", threshold)
	} else {
		fmt.Fprintln(streams.Out, "auto-switch: off")
	}
	return nil
}
