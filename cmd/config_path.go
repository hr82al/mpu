package cmd

import (
	"fmt"

	"mpu/internal/defaults"

	"github.com/spf13/cobra"
)

var configPathCmd = &cobra.Command{
	Use:   "config-path",
	Short: "Print the path to config.json",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println(defaults.FilePath())
		return nil
	},
}

func init() {
	rootCmd.AddCommand(configPathCmd)
}
