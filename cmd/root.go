package cmd

import (
	"fmt"
	"strings"

	"mpu/internal/defaults"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "mpu",
	Short: "Multi-purpose utility",
	// Run last command when called with no arguments.
	RunE: func(cmd *cobra.Command, args []string) error {
		last := strings.TrimSpace(currentConfig.Command)
		if last == "" {
			return cmd.Help()
		}
		found, _, err := cmd.Find(strings.Fields(last))
		if err != nil || found == cmd {
			return cmd.Help()
		}
		if found.RunE == nil {
			return cmd.Help()
		}
		// Commands that require positional args cannot be repeated without them.
		if found.Args != nil {
			if err := found.Args(found, []string{}); err != nil {
				return fmt.Errorf("cannot repeat %q without arguments", last)
			}
		}
		// Cobra's normal flag pipeline was not run for `found` (only for rootCmd),
		// so persistent flags parsed at root level (-s, -n, etc.) are not yet
		// visible via found.Flags(). Merge them in before calling RunE.
		found.Flags().AddFlagSet(cmd.PersistentFlags())
		return found.RunE(found, []string{})
	},
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		c, err := defaults.Load()
		if err != nil {
			c = defaults.Config{Defaults: make(defaults.Values)}
		}
		currentConfig = c
		return nil
	},
	PersistentPostRunE: func(cmd *cobra.Command, args []string) error {
		// Record the canonical command name (without binary and "webApp" prefix).
		// Only stored for webApp-related commands (shortcuts or direct webApp path).
		_, isShortcut := cmd.Annotations["commandGroup"]
		isWebApp := strings.Contains(cmd.CommandPath(), " webApp ")
		if isShortcut || isWebApp {
			name := strings.TrimPrefix(cmd.CommandPath(), "mpu ")
			name = strings.TrimPrefix(name, "webApp ")
			currentConfig.Command = name
		}
		return defaults.Save(currentConfig)
	},
}

func init() {
	rootCmd.PersistentFlags().StringP("spreadsheet-id", "s", "", "spreadsheet ID")
	rootCmd.PersistentFlags().StringP("sheet-name", "n", "", "sheet tab name")
}

func Execute() error {
	return rootCmd.Execute()
}
