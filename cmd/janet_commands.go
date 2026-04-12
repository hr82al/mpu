package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"mpu/internal/janet"

	"github.com/spf13/cobra"
)

// Janet user-commands: every .janet file in ~/.config/mpu/commands/
// (overridable via MPU_COMMANDS_DIR) becomes an `mpu <name>` subcommand.
// Script body executes with full access to mpu/*, the Janet standard
// library, and project scripts (highlight/completion/help/hint/...).
//
// Arguments after the command name are bound to the global array *args*.
//
// On script failure the interactive recovery flow (dropToRecoveryRepl)
// hands the VM to the user in a live REPL — they can inspect state, try
// fixes, or Ctrl-D out. Tests set MPU_JANET_NO_RECOVER=1 to get a plain
// error return instead.

// commandsDirMarkerAnnotation tags cobra commands created from .janet files
// so reloadJanetCommands can find & remove them on reload.
const commandsDirMarkerAnnotation = "mpuJanetCommand"

// recoveryHook is the function invoked when a Janet script errors. It is
// a package-level var so tests can replace it with a non-interactive stub.
// The default is dropToRecoveryRepl for live use.
var recoveryHook = dropToRecoveryRepl

type recoveryVM interface {
	DoString(string) (string, error)
}

// commandsDir returns the directory scanned for user .janet commands.
// Honours MPU_COMMANDS_DIR for tests & CI; falls back to
// ~/.config/mpu/janet/commands (nested under janet/ so scripts live
// alongside the rest of the Janet project tree).
func commandsDir() string {
	if dir := os.Getenv("MPU_COMMANDS_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "mpu", "janet", "commands")
}

// reloadJanetCommands removes previously-registered Janet user commands
// and re-scans the directory. Exported-ish via being callable from init()
// and tests. Safe when the directory does not exist.
func reloadJanetCommands() {
	// Strip any existing Janet-command children so reloads don't leak.
	for _, c := range rootCmd.Commands() {
		if c.Annotations != nil && c.Annotations[commandsDirMarkerAnnotation] == "true" {
			rootCmd.RemoveCommand(c)
		}
	}

	dir := commandsDir()
	if dir == "" {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".janet") {
			continue
		}
		cmdName := strings.TrimSuffix(name, ".janet")
		if cmdName == "" {
			continue
		}
		path := filepath.Join(dir, name)
		rootCmd.AddCommand(makeJanetCommand(cmdName, path))
	}
}

// makeJanetCommand builds a cobra command that runs one .janet file.
// Using DisableFlagParsing so every arg after the command name — including
// things that look like flags — reaches the script as part of *args*.
func makeJanetCommand(name, path string) *cobra.Command {
	return &cobra.Command{
		Use:                name + " [args...]",
		Short:              "Janet user command from " + path,
		DisableFlagParsing: true,
		Annotations: map[string]string{
			commandsDirMarkerAnnotation: "true",
			skipDefaultsAnnotation:      "true", // don't pollute smart-repeat
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runJanetScript(cmd.OutOrStdout(), cmd.ErrOrStderr(), path, args)
		},
	}
}

// runJanetScript boots a VM, loads project scripts, injects *args*, and
// executes the file. On error it delegates to recoveryHook so the user
// can fix things interactively (or, in tests, the hook records the error).
func runJanetScript(stdout, stderr io.Writer, path string, args []string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	vm, err := janet.New()
	if err != nil {
		return fmt.Errorf("init janet: %w", err)
	}
	defer vm.Close()

	if err := registerAllCommands(vm); err != nil {
		return fmt.Errorf("register commands: %w", err)
	}

	// Minimal state so help/completion/hint scripts can initialise even
	// in script mode (no rl/channels needed when there's no interactive
	// REPL driving completion requests).
	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     janetDir(),
	}
	for n := range state.commands {
		state.cmdNames = append(state.cmdNames, n)
	}
	registerREPLBridge(vm, state)
	loadJanetScripts(vm)

	if err := bindArgs(vm, args); err != nil {
		return fmt.Errorf("bind args: %w", err)
	}

	// Route Janet stdout/stderr to cobra's writers when the script uses
	// (print ...) etc. Janet's default prints to OS stdout, which cobra
	// may be intercepting for tests.
	redirectPrints(stdout, stderr)

	_, execErr := vm.DoString(string(data))
	// Janet buffers (print)/(eprint) on its FILE* — flush before returning
	// so cobra/test pipes receive the output.
	_, _ = vm.DoString(`(flush) (eflush)`)
	if execErr == nil {
		return nil
	}

	if os.Getenv("MPU_JANET_NO_RECOVER") == "1" {
		return execErr
	}
	return recoveryHook(vm, path, execErr)
}

// bindArgs sets (def *args* @[...]) in the VM so scripts can iterate
// over positional arguments. Strings are passed through Janet's own
// reader via string/format to avoid escaping concerns.
func bindArgs(vm *janet.VM, args []string) error {
	var sb strings.Builder
	sb.WriteString(`(def *args* @[`)
	for i, a := range args {
		if i > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(janetQuote(a))
	}
	sb.WriteString(`])`)
	_, err := vm.DoString(sb.String())
	return err
}

// janetQuote returns a Janet literal that evaluates to the given string.
// Uses backtick long-strings when the input has no backticks; otherwise
// escapes via the double-quoted form with minimal escapes.
func janetQuote(s string) string {
	if !strings.Contains(s, "`") {
		return "`" + s + "`"
	}
	// Fallback: double-quote with \ and " escaped.
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			sb.WriteString(`\\`)
		case '"':
			sb.WriteString(`\"`)
		case '\n':
			sb.WriteString(`\n`)
		case '\t':
			sb.WriteString(`\t`)
		case '\r':
			sb.WriteString(`\r`)
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// redirectPrints is a no-op right now — Janet's (print) goes to the
// real stdout which, during tests, is captured by the test harness.
// Placeholder for future stream routing if we need to respect
// cmd.OutOrStdout() fully (would require rebinding :out in Janet).
func redirectPrints(stdout, stderr io.Writer) {
	_ = stdout
	_ = stderr
}

// dropToRecoveryRepl is the default recovery handler: print the error,
// hand the existing VM (with all script-defined bindings still alive)
// to a live readline REPL so the user can inspect & retry. Ctrl-D exits
// and propagates the original error. Not testable end-to-end (needs a
// tty); tests install a stub via recoveryHook.
func dropToRecoveryRepl(vm recoveryVM, scriptPath string, origErr error) error {
	fmt.Fprintf(os.Stderr, "\033[31merror in %s:\033[0m %s\n", scriptPath, origErr)
	fmt.Fprintln(os.Stderr, "Dropped into recovery REPL. Ctrl-D exits and returns the error.")

	real, ok := vm.(*janet.VM)
	if !ok {
		// Unknown VM type (e.g., test stub) — can't run a readline loop.
		return origErr
	}
	if err := runRecoveryREPL(real, scriptPath); err != nil {
		return err
	}
	return origErr
}
