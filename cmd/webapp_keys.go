package cmd

import (
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppKeysCmd = &cobra.Command{
	Use:   "keys",
	Short: "Get header keys (first row) from a sheet",
	Example: `  mpu webApp keys -s <spreadsheet-id> -n Sheet1`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "sheet-name")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":              "spreadsheets/data/batchGet",
			"ssId":                sid,
			"ranges":             []string{fmt.Sprintf("%s!1:1", name)},
			"majorDimension":     "ROWS",
			"valueRenderOption":  "UNFORMATTED_VALUE",
			"dateTimeRenderOption": "SERIAL_NUMBER",
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
	addSpreadsheetFlag(webAppKeysCmd)
	addSheetNameFlag(webAppKeysCmd)
	webAppCmd.AddCommand(webAppKeysCmd)
}
