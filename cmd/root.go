package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "mpu",
	Short: "Multi-purpose utility",
}

func Execute() error {
	return rootCmd.Execute()
}
