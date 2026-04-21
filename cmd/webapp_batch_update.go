package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppBatchUpdateCmd = &cobra.Command{
	Use:   "batch-update <json>",
	Short: "Batch delete+update data in sheets",
	Args:  cobra.MaximumNArgs(2),
	Example: `  mpu webApp batch-update -s <id> '[{"sheetName":"Sheet1","dataRowFirst":3,"values":[["a","b"]]}]'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, bodyArgs, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}

		bodyStr, err := readBody(bodyArgs, cmd.InOrStdin())
		if err != nil {
			return err
		}
		var data []interface{}
		if err := json.Unmarshal([]byte(bodyStr), &data); err != nil {
			return fmt.Errorf("invalid JSON: %w", err)
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":                  "spreadsheets/data/batchUpdate",
			"ssId":                    sid,
			"requestBatchUpdaterData": data,
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
	addSpreadsheetFlag(webAppBatchUpdateCmd)
	webAppCmd.AddCommand(webAppBatchUpdateCmd)
}
