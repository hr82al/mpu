package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mpu/internal/janet"

	"github.com/chzyer/readline"
)

// runRecoveryREPL drives a readline loop against an already-initialised
// VM. Used by dropToRecoveryRepl after a user command fails. Shares the
// eval/prompt/highlight plumbing with the regular REPL, but advertises
// itself as a recovery session and reuses the Janet VM (bindings, state,
// and whatever partial side-effects the failing script produced).
//
// Ctrl-D exits the loop; the caller then returns the original error.
func runRecoveryREPL(vm *janet.VM, scriptPath string) error {
	// Reuse the same state shape the interactive REPL uses — keeps
	// completion/hint/highlight scripts happy.
	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     janetDir(),
		compReq:  make(chan compRequest),
		compResp: make(chan compResponse),
	}
	for n := range state.commands {
		state.cmdNames = append(state.cmdNames, n)
	}
	sort.Strings(state.cmdNames)

	home, _ := os.UserHomeDir()
	state.histFile = filepath.Join(home, ".config", "mpu", "history")

	state.hintR = newHintRenderer(state)
	rl, err := readline.NewEx(&readline.Config{
		Prompt:            recoveryPrompt(filepath.Base(scriptPath), state.counter),
		HistoryFile:       state.histFile,
		AutoComplete:      &mpuCompleter{state: state},
		Listener:          state.hintR,
		InterruptPrompt:   "^C",
		EOFPrompt:         "",
		HistorySearchFold: true,
	})
	if err != nil {
		return fmt.Errorf("init recovery readline: %w", err)
	}
	defer rl.Close()
	state.rl = rl

	fmt.Fprintf(os.Stderr,
		"\033[33mrecovery\033[0m session on \033[1m%s\033[0m — Ctrl-D to exit.\n",
		filepath.Base(scriptPath))

	// Pump: readline goroutine feeds lines, main goroutine serves
	// completion requests & evaluates. Same topology as the interactive
	// REPL to avoid cross-thread Janet calls.
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
			state.compResp <- state.doComplete(req)

		case rr := <-readCh:
			if rr.err != nil {
				fmt.Fprintln(os.Stderr)
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
				rl.SetPrompt("... ")
				startRead()
				continue
			}
			buf.Reset()
			state.counter++
			input = strings.TrimSpace(input)

			result, execErr := vm.DoEval(input)
			if execErr != nil {
				fmt.Fprintf(os.Stderr, "\033[31merror:\033[0m %s\n", execErr)
			} else if result.Str != "" || result.Type != janet.TypeNil {
				fmt.Fprintln(os.Stdout, result.Str)
			}

			rl.SetPrompt(recoveryPrompt(filepath.Base(scriptPath), state.counter))
			if state.hintR != nil {
				state.hintR.Reset()
			}
			startRead()
		}
	}
}

func recoveryPrompt(scriptName string, counter int) string {
	return fmt.Sprintf("\033[33mrecover:%s\033[0m:\033[33m%d\033[0m> ",
		scriptName, counter)
}
