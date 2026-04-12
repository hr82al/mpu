package cmd

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mpu/internal/janet"

	"github.com/chzyer/readline"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const skipDefaultsAnnotation = "skipDefaults"

var replCmd = &cobra.Command{
	Use:     "repl [script]",
	GroupID: groupMeta,
	Short:   "Janet REPL with all mpu commands available",
	Long: `Start an interactive Janet REPL with all mpu commands registered as
Janet functions under the "mpu" module prefix.

All commands are available as (mpu/<command> ...args):
  (mpu/get "-s" "SHEET_ID" "-n" "Sheet1")
  (mpu/client "42")
  (mpu/token)
  (mpu/ldb "42" "SELECT 1")

Features:
  Tab completion for commands, flags, and Janet symbols
  Persistent history with Ctrl-R search
  Multi-line input (unclosed parens)
  Syntax highlighting on output (via Janet)
  IPython-like magic: %time, %who, %hist, %load
  Result history: _, __, ___

If a script file is provided as an argument, it is executed instead
of starting the interactive REPL.

This command does NOT update the saved last-command in config.json,
so the previous command is preserved for smart repeat.`,
	Args: cobra.MaximumNArgs(1),
	Annotations: map[string]string{
		skipDefaultsAnnotation: "true",
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		vm, err := janet.New()
		if err != nil {
			return fmt.Errorf("init janet: %w", err)
		}
		defer vm.Close()

		if err := registerAllCommands(vm); err != nil {
			return fmt.Errorf("register commands: %w", err)
		}

		// Script mode: register stubs, load prelude, execute file, and exit.
		if len(args) == 1 {
			state := &replState{
				vm:       vm,
				commands: collectLeafCommands(),
				jDir:     janetDir(),
			}
			for name := range state.commands {
				state.cmdNames = append(state.cmdNames, name)
			}
			sort.Strings(state.cmdNames)
			registerREPLBridge(vm, state)
			loadJanetScripts(vm)
			data, err := os.ReadFile(args[0])
			if err != nil {
				return err
			}
			_, err = vm.DoString(string(data))
			// Janet buffers (print)/(eprint) on FILE* stdout — without
			// an explicit flush, output vanishes when stdout is a pipe
			// (test runners, make, shell redirection).
			_, _ = vm.DoString(`(flush) (eflush)`)
			return err
		}

		// Interactive REPL.
		return runInteractiveREPL(cmd, vm)
	},
}

func init() {
	rootCmd.AddCommand(replCmd)
}

// ── Interactive REPL ─────────────────────────────────────────────

type replState struct {
	vm       *janet.VM
	rl       *readline.Instance
	commands map[string]*cobra.Command // short name → cobra command
	cmdNames []string                  // sorted short names
	counter  int
	jDir     string
	histFile string
	compCtx  string         // current command context for keyword completion
	hintR    *hintRenderer  // inline-hint listener (updates prompt on context change)

	// Channel-based completion: readline's goroutine sends a request,
	// main goroutine (which owns the Janet VM) processes it.
	compReq  chan compRequest
	compResp chan compResponse
}

type compRequest struct {
	line string
	pos  int
}

type compResponse struct {
	suffixes [][]rune
	length   int
}

func runInteractiveREPL(cmd *cobra.Command, vm *janet.VM) error {
	jDir := janetDir()

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     jDir,
		compReq:  make(chan compRequest),
		compResp: make(chan compResponse),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	sort.Strings(state.cmdNames)

	registerREPLBridge(vm, state)
	loadJanetScripts(vm)

	home, _ := os.UserHomeDir()
	state.histFile = filepath.Join(home, ".config", "mpu", "history")

	state.hintR = newHintRenderer(state)
	rl, err := readline.NewEx(&readline.Config{
		Prompt:            "\033[1;36mmpu\033[0m:\033[33m0\033[0m> ",
		HistoryFile:       state.histFile,
		AutoComplete:      &mpuCompleter{state: state},
		Listener:          state.hintR,
		InterruptPrompt:   "^C",
		EOFPrompt:         "",
		HistorySearchFold: true,
	})
	if err != nil {
		return fmt.Errorf("init readline: %w", err)
	}
	defer rl.Close()
	state.rl = rl

	fmt.Fprintln(cmd.OutOrStdout(),
		"\033[1;36mmpu\033[0m janet repl — type \033[33m(?)\033[0m for help, "+
			"\033[90mTab\033[0m completion, \033[90mCtrl-D\033[0m exit")

	// Main loop: alternate between waiting for readline and serving
	// completion requests. readline blocks in a goroutine; we select
	// on its result channel and the completion request channel.
	type readResult struct {
		line string
		err  error
	}
	readCh := make(chan readResult, 1)

	startRead := func() {
		go func() {
			line, err := rl.Readline()
			readCh <- readResult{line, err}
		}()
	}

	var buf strings.Builder
	startRead()

	for {
		select {
		case req := <-state.compReq:
			// Completion request from readline's goroutine.
			// We are on the main goroutine — safe to call Janet.
			resp := state.doComplete(req)
			state.compResp <- resp

		case rr := <-readCh:
			if rr.err != nil {
				fmt.Fprintln(cmd.OutOrStdout())
				return nil
			}

			line := strings.TrimSpace(rr.line)
			if line == "" {
				startRead()
				continue
			}

			buf.WriteString(line)
			buf.WriteString(" ")
			input := buf.String()

			if !isBalanced(input) {
				cp, cpErr := vm.DoString(`(prompt/continuation)`)
				if cpErr != nil || cp == "" {
					cp = "... "
				}
				rl.SetPrompt(cp)
				startRead()
				continue
			}
			buf.Reset()

			state.counter++
			input = strings.TrimSpace(input)

			vm.DoString(fmt.Sprintf(`(set *counter* %d)`, state.counter))
			vm.DoString(fmt.Sprintf(`(set _iii _ii) (set _ii _i) (set _i %q)`, input))

			// Rotate result history inside the eval so the actual Janet value
			// is bound — avoids re-parsing result.Str, which breaks on strings
			// containing spaces/brackets (e.g. error messages).
			wrapped := fmt.Sprintf(`(let [r (do %s)] (set ___ __) (set __ _) (set _ r) r)`, input)
			result, execErr := vm.DoEval(wrapped)
			if execErr != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "\033[31merror:\033[0m %s\n", execErr)
			} else if result.Str != "" || result.Type != janet.TypeNil {
				highlighted, hlErr := vm.DoString(
					fmt.Sprintf(`(highlight/result %d %q)`, int(result.Type), result.Str))
				if hlErr == nil && highlighted != "" {
					fmt.Fprintln(cmd.OutOrStdout(), highlighted)
				} else {
					fmt.Fprintln(cmd.OutOrStdout(), result.Str)
				}
			}

			prompt, pErr := vm.DoString(`(prompt/get)`)
			if pErr != nil || prompt == "" {
				prompt = fmt.Sprintf("\033[1;36mmpu\033[0m:\033[33m%d\033[0m> ", state.counter)
			}
			rl.SetPrompt(prompt)
			// Counter advanced — force the next OnChange to re-render the
			// hint frame on top of the new prompt.
			if state.hintR != nil {
				state.hintR.Reset()
			}
			startRead()
		}
	}
}

// doComplete runs completion logic on the main goroutine (Janet-safe).
// Flags (--style and :keyword style) use Go for speed.
// Commands and symbols go through Janet for full environment access.
func (s *replState) doComplete(req compRequest) compResponse {
	line := req.line[:req.pos]
	word := extractCurrentWord(line)

	var candidates []string

	switch {
	case strings.HasPrefix(word, "--") || (strings.HasPrefix(word, "-") && !strings.HasPrefix(word, ":")):
		// CLI-style flag completion — pure Go.
		cmdName := findEnclosingCommand(line)
		if cmd, ok := s.commands[cmdName]; ok {
			addFlags := func(fs *pflag.FlagSet) {
				fs.VisitAll(func(f *pflag.Flag) {
					if f.Name == "help" {
						return
					}
					long := "--" + f.Name
					if strings.HasPrefix(long, word) {
						candidates = append(candidates, long)
					}
					if f.Shorthand != "" {
						short := "-" + f.Shorthand
						if strings.HasPrefix(short, word) {
							candidates = append(candidates, short)
						}
					}
				})
			}
			addFlags(cmd.Flags())
			addFlags(cmd.InheritedFlags())
		}

	case strings.HasPrefix(word, ":"):
		// Keyword-flag completion (:sheet-name etc.) — Go for speed.
		cmdName := findEnclosingCommand(line)
		if cmd, ok := s.commands[cmdName]; ok {
			addKwFlags := func(fs *pflag.FlagSet) {
				fs.VisitAll(func(f *pflag.Flag) {
					if f.Name == "help" {
						return
					}
					kw := ":" + f.Name
					if strings.HasPrefix(kw, word) {
						candidates = append(candidates, kw)
					}
				})
			}
			addKwFlags(cmd.Flags())
			addKwFlags(cmd.InheritedFlags())
		}
		// Also try Janet for general keyword completion.
		if len(candidates) == 0 {
			s.compCtx = findEnclosingCommand(line)
			arr, err := s.vm.EvalStringSlice(
				fmt.Sprintf(`(complete/candidates %q %q)`, line, word))
			if err == nil && len(arr) > 0 {
				candidates = arr
			}
		}

	default:
		// Ask Janet for completions (commands + symbols + params).
		s.compCtx = findEnclosingCommand(line)
		arr, err := s.vm.EvalStringSlice(
			fmt.Sprintf(`(complete/candidates %q %q)`, line, word))
		if err == nil && len(arr) > 0 {
			candidates = arr
		}
		if len(candidates) == 0 && word != "" {
			// Fallback to Go-only for mpu/ commands.
			for _, name := range s.cmdNames {
				full := "mpu/" + name
				if strings.HasPrefix(full, word) {
					candidates = append(candidates, full)
				}
			}
		}
	}

	if len(candidates) == 0 {
		return compResponse{}
	}

	wLen := len(word)
	out := make([][]rune, len(candidates))
	for i, cand := range candidates {
		if len(cand) > wLen {
			out[i] = []rune(cand[wLen:])
		} else {
			out[i] = []rune("")
		}
	}
	return compResponse{suffixes: out, length: wLen}
}

// ── Tab completion (channel bridge to main goroutine) ────────────

type mpuCompleter struct {
	state *replState
}

func (c *mpuCompleter) Do(line []rune, pos int) ([][]rune, int) {
	// Send request to main goroutine, wait for response.
	c.state.compReq <- compRequest{line: string(line), pos: pos}
	resp := <-c.state.compResp
	return resp.suffixes, resp.length
}

// ── Bridge functions (Go → Janet) ────────────────────────────────

func registerREPLBridge(vm *janet.VM, state *replState) {
	vm.Register("repl", "commands", "List all registered mpu commands (name<tab>doc per line)", func(args []string) (string, error) {
		var sb strings.Builder
		for _, name := range state.cmdNames {
			cmd := state.commands[name]
			sb.WriteString(name)
			sb.WriteByte('\t')
			sb.WriteString(cmd.Short)
			sb.WriteByte('\n')
		}
		return sb.String(), nil
	})

	vm.Register("repl", "flags", "List flags for a command", func(args []string) (string, error) {
		if len(args) == 0 {
			return "", nil
		}
		name := args[0]
		cmd, ok := state.commands[name]
		if !ok {
			return "", nil
		}
		var sb strings.Builder
		cmd.Flags().VisitAll(func(f *pflag.Flag) {
			if f.Name != "help" {
				sb.WriteString("--")
				sb.WriteString(f.Name)
				sb.WriteByte('\n')
				if f.Shorthand != "" {
					sb.WriteByte('-')
					sb.WriteString(f.Shorthand)
					sb.WriteByte('\n')
				}
			}
		})
		cmd.InheritedFlags().VisitAll(func(f *pflag.Flag) {
			if f.Name != "help" {
				sb.WriteString("--")
				sb.WriteString(f.Name)
				sb.WriteByte('\n')
				if f.Shorthand != "" {
					sb.WriteByte('-')
					sb.WriteString(f.Shorthand)
					sb.WriteByte('\n')
				}
			}
		})
		return sb.String(), nil
	})

	vm.Register("repl", "doc", "Full help text for a command", func(args []string) (string, error) {
		if len(args) == 0 {
			return "", nil
		}
		name := args[0]
		cmd, ok := state.commands[name]
		if !ok {
			return "", nil
		}
		var sb strings.Builder
		sb.WriteString(cmd.Short)
		sb.WriteByte('\n')
		if cmd.Long != "" {
			sb.WriteByte('\n')
			sb.WriteString(cmd.Long)
			sb.WriteByte('\n')
		}
		usage := cmd.UsageString()
		if usage != "" {
			sb.WriteByte('\n')
			sb.WriteString(usage)
		}
		return sb.String(), nil
	})

	vm.Register("repl", "janet-dir", "Path to the Janet scripts directory", func(args []string) (string, error) {
		return state.jDir, nil
	})

	vm.Register("repl", "history-file", "Path to the REPL history file", func(args []string) (string, error) {
		return state.histFile, nil
	})

	vm.Register("repl", "completion-context", "Current mpu command context for keyword completion", func(args []string) (string, error) {
		return state.compCtx, nil
	})

	vm.Register("repl", "history", "Return last N history entries", func(args []string) (string, error) {
		n := 20
		if len(args) > 0 {
			fmt.Sscanf(args[0], "%d", &n)
		}
		data, err := os.ReadFile(state.histFile)
		if err != nil {
			return "", nil
		}
		lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		start := len(lines) - n
		if start < 0 {
			start = 0
		}
		return strings.Join(lines[start:], "\n"), nil
	})
}

// ── Helpers ──────────────────────────────────────────────────────

func extractCurrentWord(s string) string {
	if s == "" {
		return ""
	}
	i := len(s) - 1
	for i >= 0 {
		ch := s[i]
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '(' || ch == ')' ||
			ch == '[' || ch == ']' || ch == '{' || ch == '}' {
			break
		}
		i--
	}
	return s[i+1:]
}

func findEnclosingCommand(s string) string {
	idx := strings.LastIndex(s, "(mpu/")
	if idx < 0 {
		idx = strings.LastIndex(s, "mpu/")
		if idx < 0 {
			return ""
		}
	} else {
		idx++
	}
	rest := s[idx:]
	end := strings.IndexAny(rest, " \t\n()[]{}\"")
	if end < 0 {
		end = len(rest)
	}
	name := rest[:end]
	if strings.HasPrefix(name, "mpu/") {
		return name[4:]
	}
	return ""
}

// ── Janet script loading ─────────────────────────────────────────

func janetDir() string {
	if dir := os.Getenv("MPU_JANET_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "mpu", "janet")
}

func loadJanetScripts(vm *janet.VM) {
	dir := janetDir()
	scripts := []string{
		"highlight.janet",
		"prelude.janet",
		"help.janet",
		"completion.janet",
		"prompt.janet",
		"hint.janet",
		"ss-analyze.janet",
		"init.janet",
	}
	for _, name := range scripts {
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		vm.DoString(string(data))
	}
	rcPath := filepath.Join(dir, "rc.janet")
	if data, err := os.ReadFile(rcPath); err == nil {
		vm.DoString(string(data))
	}
}

// ── Multi-line support ───────────────────────────────────────────

func isBalanced(s string) bool {
	depth := 0
	inString := false
	escaped := false
	for _, ch := range s {
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' && inString {
			escaped = true
			continue
		}
		if ch == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		switch ch {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		}
	}
	return depth <= 0
}

// ── Command collection ───────────────────────────────────────────

func collectLeafCommands() map[string]*cobra.Command {
	m := make(map[string]*cobra.Command)
	collectCmds(rootCmd, "", m)
	return m
}

func collectCmds(parent *cobra.Command, prefix string, m map[string]*cobra.Command) {
	for _, child := range parent.Commands() {
		name := child.Name()
		if prefix != "" {
			name = prefix + "/" + name
		}
		if name == "help" || name == "repl" || name == "completion" {
			continue
		}
		if len(child.Commands()) > 0 {
			collectCmds(child, name, m)
			continue
		}
		m[name] = child
	}
}

// ── Command registration ─────────────────────────────────────────

func registerAllCommands(vm *janet.VM) error {
	return registerCmdTree(vm, rootCmd, "")
}

func registerCmdTree(vm *janet.VM, parent *cobra.Command, prefix string) error {
	for _, child := range parent.Commands() {
		name := child.Name()
		if prefix != "" {
			name = prefix + "/" + name
		}
		if name == "help" || name == "repl" || name == "completion" {
			continue
		}
		sub := child.Commands()
		if len(sub) > 0 {
			if err := registerCmdTree(vm, child, name); err != nil {
				return err
			}
			continue
		}
		doc := child.Short
		if err := registerCobraCmd(vm, name, doc, child); err != nil {
			return err
		}
	}
	return nil
}

func registerCobraCmd(vm *janet.VM, name, doc string, cobraCmd *cobra.Command) error {
	return vm.Register("mpu", name, doc, func(args []string) (string, error) {
		var buf bytes.Buffer
		origOut := rootCmd.OutOrStdout()
		rootCmd.SetOut(&buf)
		cobraCmd.SetOut(&buf)
		defer func() {
			rootCmd.SetOut(origOut)
			cobraCmd.SetOut(origOut)
		}()

		// Convert keyword args (:flag-name "value") to CLI flags (--flag-name value).
		// Positional args pass through unchanged.
		cliArgs := keywordsToCLI(args)

		cmdArgs := append(strings.Fields(cobraCmd.CommandPath()), cliArgs...)
		if len(cmdArgs) > 0 && cmdArgs[0] == "mpu" {
			cmdArgs = cmdArgs[1:]
		}
		rootCmd.SetArgs(cmdArgs)

		// Clear sticky flag state from prior invocations so a fresh call
		// behaves like a new CLI process (positional args resolve via
		// resolveSpreadsheetID, saved defaults still apply via currentConfig).
		resetCobraFlags(cobraCmd)

		if err := rootCmd.Execute(); err != nil {
			return "", err
		}

		return strings.TrimRight(buf.String(), "\n"), nil
	})
}

// resetCobraFlags clears sticky flag state (Changed + Value) on the command's
// local and inherited flags so each REPL call behaves like a fresh invocation.
// Flag defaults are restored from f.DefValue; persisted smart-defaults still
// apply because commands read from currentConfig.Defaults, not flag values.
//
// SliceValue flags (StringArray, StringSlice) need Replace(nil) instead of
// Set(DefValue): their Set appends, and DefValue is the literal "[]", so
// calling Set("[]") would leave a stray "[]" entry in the slice.
func resetCobraFlags(cmd *cobra.Command) {
	reset := func(fs *pflag.FlagSet) {
		fs.VisitAll(func(f *pflag.Flag) {
			if sv, ok := f.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(nil)
			} else {
				_ = f.Value.Set(f.DefValue)
			}
			f.Changed = false
		})
	}
	reset(cmd.Flags())
	reset(cmd.InheritedFlags())
}

// keywordsToCLI converts Janet keyword arguments to CLI flags.
// :spreadsheet-id "X" → --spreadsheet-id X
// :s "X" → -s X
// Positional args (not starting with :) pass through.
func keywordsToCLI(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, ":") {
			name := a[1:]
			if len(name) == 1 {
				out = append(out, "-"+name)
			} else {
				out = append(out, "--"+name)
			}
		} else if strings.HasPrefix(a, "--") || strings.HasPrefix(a, "-") {
			// Pass through existing CLI-style flags.
			out = append(out, a)
		} else {
			out = append(out, a)
		}
	}
	return out
}
