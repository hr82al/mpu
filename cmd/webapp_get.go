package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppGetCmd = &cobra.Command{
	Use:   "get",
	Args:  cobra.MaximumNArgs(1),
	Short: "Get data items from a sheet",
	Example: `  mpu webApp get -s <spreadsheet-id> -n Sheet1
  mpu webApp get -s <spreadsheet-id> -n Sheet1 --header-row 1 --data-row 3`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, _, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "sheet-name")
		if err != nil {
			return err
		}
		headerRow := getIntFlag(cmd, "header-row")
		dataRow := getIntFlag(cmd, "data-row")

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":       "spreadsheets/data/get",
			"ssId":         sid,
			"sheetName":    name,
			"keysRow":      headerRow,
			"dataRowFirst": dataRow,
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
	addSpreadsheetFlag(webAppGetCmd)
	addSheetNameFlag(webAppGetCmd)
	webAppGetCmd.Flags().Int("header-row", 1, "header row number")
	webAppGetCmd.Flags().Int("data-row", 3, "first data row number")
	webAppCmd.AddCommand(webAppGetCmd)
}
