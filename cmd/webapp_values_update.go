package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppValuesUpdateCmd = &cobra.Command{
	Use:   "values-update <json>",
	Short: "Batch update cell values (pure batchUpdate)",
	Args:  cobra.ExactArgs(1),
	Example: `  mpu webApp values-update -s <id> '{"valueInputOption":"USER_ENTERED","data":[{"range":"Sheet1!A1","values":[["hello"]]}]}'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}

		var data map[string]interface{}
		if err := json.Unmarshal([]byte(args[0]), &data); err != nil {
			return fmt.Errorf("invalid JSON: %w", err)
		}
		if _, ok := data["valueInputOption"]; !ok {
			return fmt.Errorf("valueInputOption is required (USER_ENTERED or RAW)")
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":      "spreadsheets/values/batchUpdate",
			"ssId":        sid,
			"requestBody": data,
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
	webAppCmd.AddCommand(webAppValuesUpdateCmd)
}
