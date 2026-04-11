package cmd

import (
	"mpu/internal/config"

	"github.com/spf13/cobra"
)

var lsdbCmd = &cobra.Command{
	Use:     "lsdb <sql>",
	GroupID: groupSL,
	Short:   "Run SQL on local DB with explicit schema (127.0.0.1)",
	Long: `Run a SQL query against an explicit schema on the local PostgreSQL instance.

Unlike ldb (which derives schema from client-id), lsdb uses --scheme directly
as the PostgreSQL search_path and role name.

Flag --scheme is saved to defaults after first use:

  mpu lsdb --scheme schema_42 "SELECT 1"          # saves scheme
  mpu lsdb "SELECT 1"                              # reuses saved scheme`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		scheme, err := requireFlag(cmd, "scheme")
		if err != nil {
			return err
		}
		cfg, err := config.LoadPG()
		if err != nil {
			return err
		}
		return runQuery(cfg, cfg.Host, cfg.LocalPort, scheme, args[0])
	},
}

func init() {
	lsdbCmd.Flags().String("scheme", "", "PostgreSQL schema/role name")
	rootCmd.AddCommand(lsdbCmd)
}
