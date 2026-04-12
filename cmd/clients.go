package cmd

import (
	"fmt"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/defaults"
	"mpu/internal/slapi"

	"github.com/spf13/cobra"
)

var clientsCmd = &cobra.Command{
	Use:     "clients",
	GroupID: groupSL,
	Short: "Fetch all clients from sl-back and sync to local cache",
	Long: `Calls GET /api/admin/client, then fully replaces the local sl_clients table
in ~/.config/mpu/db. On success the old data is discarded and replaced atomically.
Prints the number of clients synced.

Not available in forceCache=use mode (network unavailable).`,
	RunE: func(cmd *cobra.Command, args []string) error {
		db, err := cache.Open()
		if err != nil {
			return err
		}
		defer db.Close()

		if currentConfig.ForceCache == defaults.CacheModeUse {
			return fmt.Errorf("network unavailable (forceCache=use): cannot sync clients from API")
		}

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

		fmt.Printf("synced %d clients\n", len(rows))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(clientsCmd)
}
