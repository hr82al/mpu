package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppInsertCmd = &cobra.Command{
	Use:   "insert <json-array>",
	Short: "Insert data items into a sheet",
	Args:  cobra.ExactArgs(1),
	Example: `  mpu webApp insert -s <id> -n Sheet1 '[{"col1":"val1"}]'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, err := requireFlag(cmd, "spreadsheet-id")
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
		if err := json.Unmarshal([]byte(args[0]), &data); err != nil {
			return fmt.Errorf("invalid JSON array: %w", err)
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":       "spreadsheets/data/insert",
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
	webAppInsertCmd.Flags().Int("header-row", 1, "header row number")
	webAppInsertCmd.Flags().Int("data-row", 3, "first data row number")
	webAppCmd.AddCommand(webAppInsertCmd)
}
