package cli

import (
	"fmt"
	"io"
	"strings"
)

func runCompletion(args []string, streams IO) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: ocx completion <bash|zsh|fish|powershell>")
	}
	script, err := completionScript(strings.ToLower(args[0]))
	if err != nil {
		return err
	}
	_, err = io.WriteString(streams.Out, script)
	return err
}

func completionScript(shell string) (string, error) {
	completionCommands := registeredCommandNames(true)
	commands := strings.Join(completionCommands, " ")
	switch shell {
	case "bash":
		return fmt.Sprintf("_ocx_complete() { COMPREPLY=( $(compgen -W %q -- \"${COMP_WORDS[COMP_CWORD]}\") ); }\ncomplete -F _ocx_complete ocx opencodex\n", commands), nil
	case "zsh":
		return fmt.Sprintf("#compdef ocx opencodex\n_ocx() { local -a commands; commands=(%s); _describe 'command' commands; }\ncompdef _ocx ocx opencodex\n", commands), nil
	case "fish":
		var out strings.Builder
		for _, command := range completionCommands {
			fmt.Fprintf(&out, "complete -c ocx -c opencodex -f -n '__fish_use_subcommand' -a %s\n", command)
		}
		return out.String(), nil
	case "powershell", "pwsh":
		return fmt.Sprintf("$ocxCommands = '%s'.Split(' ')\nRegister-ArgumentCompleter -Native -CommandName ocx,opencodex -ScriptBlock { param($wordToComplete) $ocxCommands | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n", commands), nil
	default:
		return "", fmt.Errorf("unsupported shell %q; choose bash, zsh, fish, or powershell", shell)
	}
}
