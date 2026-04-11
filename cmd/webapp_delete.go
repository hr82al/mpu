package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppDeleteCmd = &cobra.Command{
	Use:   "delete",
	Short: "Delete a spreadsheet",
	Example: `  mpu webApp delete -s <spreadsheet-id>`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":         "spreadsheets/delete",
			"spreadsheet_id": sid,
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
	webAppCmd.AddCommand(webAppDeleteCmd)
}
