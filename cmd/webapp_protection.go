package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppProtectionCmd = &cobra.Command{
	Use:   "protection <json>",
	Short: "Set sheet protection configs",
	Args:  cobra.RangeArgs(1, 2),
	Example: `  mpu webApp protection -s <id> '[{"sheetName":"Sheet1","protectedRanges":[{"editors":["a@b.c"]}]}]'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, bodyArgs, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}

		var configs []interface{}
		if err := json.Unmarshal([]byte(bodyArgs[0]), &configs); err != nil {
			return fmt.Errorf("invalid JSON: %w", err)
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":            "spreadsheets/sheets/protection/set",
			"ssId":              sid,
			"protectionConfigs": configs,
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
	addSpreadsheetFlag(webAppProtectionCmd)
	webAppCmd.AddCommand(webAppProtectionCmd)
}
