package cmd

import (
	"fmt"

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
  mpu lsdb "SELECT 1"                              # reuses saved scheme

When remotePostgresOnly is enabled, --host flag is required and routes to remote PostgreSQL.`,
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

		// If remotePostgresOnly, use remote credentials and host
		if currentConfig.RemotePostgresOnly {
			hostFlag, err := requireFlag(cmd, "host")
			if err != nil {
				return fmt.Errorf("--host is required with remotePostgresOnly")
			}
			if cfg.MyUserName == "" || cfg.MyUserPassword == "" {
				return fmt.Errorf("PG_MY_USER_NAME and PG_MY_USER_PASSWORD are required for lsdb with remotePostgresOnly")
			}
			return runQueryWithCreds(cfg.DBName, resolveHost(hostFlag), cfg.RemotePort,
				cfg.MyUserName, cfg.MyUserPassword, scheme, args[0])
		}

		if cfg.MainUserName == "" || cfg.MainUserPassword == "" {
			return fmt.Errorf("PG_MAIN_USER_NAME and PG_MAIN_USER_PASSWORD are required for lsdb")
		}
		return runQueryWithCreds(cfg.DBName, cfg.Host, cfg.LocalPort,
			cfg.MainUserName, cfg.MainUserPassword, scheme, args[0])
	},
}

func init() {
	lsdbCmd.Flags().String("scheme", "", "PostgreSQL schema/role name")
	lsdbCmd.Flags().String("host", "", "remote host (server name from .env or direct address, required for remotePostgresOnly)")
	rootCmd.AddCommand(lsdbCmd)
}
