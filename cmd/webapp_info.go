package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppInfoCmd = &cobra.Command{
	Use:   "info",
	Short: "Get spreadsheet metadata",
	Example: `  mpu webApp info -s <spreadsheet-id>`,
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
			"action": "spreadsheets/get",
			"ssId":   sid,
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
	addSpreadsheetFlag(webAppInfoCmd)
	webAppCmd.AddCommand(webAppInfoCmd)
}
