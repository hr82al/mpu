package cmd

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"

	"mpu/internal/janet"

	"github.com/spf13/cobra"
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

		// Script mode: execute file and exit.
		if len(args) == 1 {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return err
			}
			_, err = vm.DoString(string(data))
			return err
		}

		// Interactive REPL.
		fmt.Fprintln(cmd.OutOrStdout(), "mpu janet repl (type (doc mpu/get) for help, Ctrl-D to exit)")
		scanner := bufio.NewScanner(os.Stdin)
		for {
			fmt.Fprint(cmd.OutOrStdout(), "janet> ")
			if !scanner.Scan() {
				break
			}
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			result, err := vm.DoString(line)
			if err != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "error: %s\n", err)
				continue
			}
			if result != "" {
				fmt.Fprintln(cmd.OutOrStdout(), result)
			}
		}
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	},
}

func init() {
	rootCmd.AddCommand(replCmd)
}

// registerAllCommands registers every leaf cobra command as a Janet function.
// Commands are called as (mpu/<name> arg1 arg2 ...).
func registerAllCommands(vm *janet.VM) error {
	return registerCmdTree(vm, rootCmd, "")
}

func registerCmdTree(vm *janet.VM, parent *cobra.Command, prefix string) error {
	for _, child := range parent.Commands() {
		name := child.Name()
		if prefix != "" {
			name = prefix + "/" + name
		}

		// Skip help commands and the repl itself.
		if name == "help" || name == "repl" || name == "completion" {
			continue
		}

		sub := child.Commands()
		if len(sub) > 0 {
			// Has subcommands — register children, not the parent.
			if err := registerCmdTree(vm, child, name); err != nil {
				return err
			}
			continue
		}

		// Leaf command — register it.
		doc := child.Short
		if err := registerCobraCmd(vm, name, doc, child); err != nil {
			return err
		}
	}
	return nil
}

func registerCobraCmd(vm *janet.VM, name, doc string, cobraCmd *cobra.Command) error {
	return vm.Register("mpu", name, doc, func(args []string) (string, error) {
		// Capture stdout.
		var buf bytes.Buffer
		origOut := rootCmd.OutOrStdout()
		rootCmd.SetOut(&buf)
		cobraCmd.SetOut(&buf)
		defer func() {
			rootCmd.SetOut(origOut)
			cobraCmd.SetOut(origOut)
		}()

		// Build arg list: command path + args.
		cmdArgs := append(strings.Fields(cobraCmd.CommandPath()), args...)
		// Strip "mpu" prefix — rootCmd.SetArgs expects args after binary name.
		if len(cmdArgs) > 0 && cmdArgs[0] == "mpu" {
			cmdArgs = cmdArgs[1:]
		}
		rootCmd.SetArgs(cmdArgs)
		if err := rootCmd.Execute(); err != nil {
			return "", err
		}

		return strings.TrimRight(buf.String(), "\n"), nil
	})
}
