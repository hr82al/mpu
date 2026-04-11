package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new spreadsheet",
	Example: `  mpu webApp create --email user@example.com --name "My Sheet"`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		email, err := requireFlag(cmd, "email")
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "name")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":      "spreadsheets/create",
			"email":       email,
			"projectName": name,
		})
		if err != nil {
			return err
		}
		if err := checkResp(resp); err != nil {
			return err
		}
		printRaw(resp.Result)
		return nil
	},
}

func init() {
	webAppCreateCmd.Flags().String("email", "", "owner email")
	webAppCreateCmd.Flags().String("name", "", "spreadsheet name")
	webAppCmd.AddCommand(webAppCreateCmd)
}
