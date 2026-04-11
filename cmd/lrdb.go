package cmd

import (
	"fmt"

	"mpu/internal/config"

	"github.com/spf13/cobra"
)

var lrdbCmd = &cobra.Command{
	Use:     "lrdb <sql>",
	GroupID: groupSL,
	Short:   "Run SQL on remote DB with explicit schema and host",
	Long: `Run a SQL query against an explicit schema on a remote PostgreSQL instance.

Unlike rdb (which resolves host from client's server field), lrdb takes --host
explicitly. The host value is resolved through .env (e.g. "sl-1" → sl_1=10.0.0.1),
falling back to using the value as a direct address.

Flags --scheme and --host are saved to defaults after first use:

  mpu lrdb --scheme schema_42 --host sl-1 "SELECT 1"   # saves both
  mpu lrdb "SELECT 1"                                   # reuses saved`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		scheme, err := requireFlag(cmd, "scheme")
		if err != nil {
			return err
		}
		hostFlag, err := requireFlag(cmd, "host")
		if err != nil {
			return err
		}
		cfg, err := config.LoadPG()
		if err != nil {
			return err
		}
		if cfg.MyUserName == "" || cfg.MyUserPassword == "" {
			return fmt.Errorf("PG_MY_USER_NAME and PG_MY_USER_PASSWORD are required for lrdb")
		}
		return runQueryWithCreds(cfg.DBName, resolveHost(hostFlag), cfg.RemotePort,
			cfg.MyUserName, cfg.MyUserPassword, scheme, args[0])
	},
}

func init() {
	lrdbCmd.Flags().String("scheme", "", "PostgreSQL schema/role name")
	lrdbCmd.Flags().String("host", "", "remote host (server name from .env or direct address)")
	rootCmd.AddCommand(lrdbCmd)
}
