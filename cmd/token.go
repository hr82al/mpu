package cmd

import (
	"fmt"

	"mpu/internal/cache"

	"github.com/spf13/cobra"
)

var tokenCmd = &cobra.Command{
	Use:     "token",
	GroupID: groupSL,
	Short: "Get sl-back auth token (cached for 10 min)",
	Long: `Fetches a JWT access token from sl-back via POST /api/auth/login.
The token is cached in ~/.config/mpu/db for 10 minutes; subsequent calls
within that window return the cached value without a network request.

In forceCache=use mode, returns cached token without TTL check.

Required .env vars: NEXT_PUBLIC_SERVER_URL, BASE_API_URL, TOKEN_EMAIL, TOKEN_PASSWORD.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		db, err := cache.Open()
		if err != nil {
			return err
		}
		defer db.Close()

		tok, err := getAuthToken(db)
		if err != nil {
			return err
		}
		fmt.Println(tok)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(tokenCmd)
}
