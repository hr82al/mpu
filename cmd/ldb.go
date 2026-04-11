package cmd

import (
	"context"
	"fmt"

	"mpu/internal/config"
	"mpu/internal/pgclient"

	"github.com/spf13/cobra"
)

var ldbCmd = &cobra.Command{
	Use:     "ldb [id] <sql>",
	GroupID: groupSL,
	Short:   "Run SQL on local client schema (127.0.0.1:5441)",
	Long: `Run a SQL query against a client's schema on the local PostgreSQL instance.

Connects as role client_{id} which has search_path pre-set to schema_{id}.

The client ID is optional after the first use — it is saved to defaults:

  mpu ldb 42 "SELECT COUNT(*) FROM orders"   # runs query, saves id=42
  mpu ldb "SELECT 1"                          # reuses saved id=42

The SQL argument is never saved to defaults.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, sql, err := resolveDBArgs(args)
		if err != nil {
			return err
		}

		cfg, err := config.LoadPG()
		if err != nil {
			return err
		}

		ctx := context.Background()
		user := fmt.Sprintf("client_%d", id)
		conn, err := pgclient.NewConn(ctx, cfg.Host, cfg.LocalPort, user, cfg.ClientPassword, cfg.DBName)
		if err != nil {
			return err
		}
		defer conn.Close(ctx)

		rows, err := pgclient.QueryJSON(ctx, conn, sql)
		if err != nil {
			return err
		}
		printJSON(rows)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(ldbCmd)
}
