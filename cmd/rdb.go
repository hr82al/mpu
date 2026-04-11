package cmd

import (
	"fmt"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/config"
	"mpu/internal/slapi"

	"github.com/spf13/cobra"
)

var rdbCmd = &cobra.Command{
	Use:     "rdb [id] <sql>",
	GroupID: groupSL,
	Short:   "Run SQL on remote client schema (host resolved from .env via server name)",
	Long: `Run a SQL query against a client's schema on the remote PostgreSQL instance.

The remote host is resolved by reading the client's 'server' field from the local
cache and looking up the matching env var in ~/.config/mpu/.env:

  # .env
  sl-1=10.0.0.1
  sl-2=10.0.0.2

Connects as role client_{id} which has search_path pre-set to schema_{id}.

The client ID is optional after the first use — it is saved to defaults:

  mpu rdb 42 "SELECT COUNT(*) FROM orders"   # runs query, saves id=42
  mpu rdb "SELECT 1"                          # reuses saved id=42

The SQL argument is never saved to defaults.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, sql, err := resolveDBArgs(args)
		if err != nil {
			return err
		}

		// Resolve remote host via client's server field.
		db, err := cache.Open()
		if err != nil {
			return err
		}
		defer db.Close()

		client, ok := db.GetClient(id)
		if !ok {
			// Not cached — sync from API and retry.
			token, err := auth.GetToken(db)
			if err != nil {
				return err
			}
			rows, err := slapi.GetClients(token)
			if err != nil {
				return err
			}
			if err := db.ReplaceClients(rows); err != nil {
				return fmt.Errorf("store clients: %w", err)
			}
			client, ok = db.GetClient(id)
			if !ok {
				return fmt.Errorf("client %d not found", id)
			}
		}

		cfg, err := config.LoadPG()
		if err != nil {
			return err
		}

		host, err := resolveRemoteHost(client.Server)
		if err != nil {
			return err
		}

		return runQuery(cfg, host, cfg.RemotePort, fmt.Sprintf("client_%d", id), sql)
	},
}

func init() {
	rootCmd.AddCommand(rdbCmd)
}
