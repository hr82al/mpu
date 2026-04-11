package cmd

import (
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppBatchGetCmd = &cobra.Command{
	Use:   "batch-get",
	Short: "Batch get values from multiple ranges",
	Example: `  mpu webApp batch-get -s <id> -r 'Sheet1!A1:B2' -r 'Sheet1!C1:D2'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		ranges, _ := cmd.Flags().GetStringArray("range")
		if len(ranges) == 0 {
			return fmt.Errorf("--range (-r) is required")
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":               "spreadsheets/data/batchGet",
			"ssId":                 sid,
			"ranges":               ranges,
			"majorDimension":       "ROWS",
			"valueRenderOption":    "UNFORMATTED_VALUE",
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
	webAppBatchGetCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppCmd.AddCommand(webAppBatchGetCmd)
}
