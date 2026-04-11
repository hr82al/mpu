package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppSetCmd = &cobra.Command{
	Use:   "set <json-array>",
	Short: "Replace data items in a sheet",
	Args:  cobra.RangeArgs(1, 2),
	Example: `  mpu webApp set -s <id> -n Sheet1 '[{"col1":"val1","col2":"val2"}]'
  mpu webApp set -s <id> -n Sheet1 --header-row 1 --data-row 3 '[{"A":"1"}]'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, bodyArgs, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "sheet-name")
		if err != nil {
			return err
		}
		headerRow := getIntFlag(cmd, "header-row")
		dataRow := getIntFlag(cmd, "data-row")

		var data []interface{}
		if err := json.Unmarshal([]byte(bodyArgs[0]), &data); err != nil {
			return fmt.Errorf("invalid JSON array: %w", err)
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":       "spreadsheets/data/replace",
			"ssId":         sid,
			"sheetName":    name,
			"keysRow":      headerRow,
			"dataRowFirst": dataRow,
			"dataItems":    data,
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
	addSpreadsheetFlag(webAppSetCmd)
	addSheetNameFlag(webAppSetCmd)
	webAppSetCmd.Flags().Int("header-row", 1, "header row number")
	webAppSetCmd.Flags().Int("data-row", 3, "first data row number")
	webAppCmd.AddCommand(webAppSetCmd)
}
