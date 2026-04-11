package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppBatchGetCmd = &cobra.Command{
	Use:   "batch-get",
	Args:  cobra.MaximumNArgs(1),
	Short: "Batch get values from multiple ranges",
	Example: `  mpu webApp batch-get -s <id> -r 'Sheet1!A1:B2' -r 'Sheet1!C1:D2'
  mpu batch-get -s <id> -n UNIT`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, _, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}
		ranges, err := resolveRanges(cmd)
		if err != nil {
			return err
		}
		vro, _ := cmd.Flags().GetString("value-render")

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":               "spreadsheets/values/batchGet",
			"ssId":                 sid,
			"ranges":               ranges,
			"majorDimension":       "ROWS",
			"valueRenderOption":    vro,
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
	addSpreadsheetFlag(webAppBatchGetCmd)
	addSheetNameFlag(webAppBatchGetCmd)
	webAppBatchGetCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppBatchGetCmd.Flags().String("value-render", "UNFORMATTED_VALUE", "value render option: UNFORMATTED_VALUE, FORMATTED_VALUE, FORMULA")
	_ = webAppBatchGetCmd.RegisterFlagCompletionFunc("value-render", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"UNFORMATTED_VALUE", "FORMATTED_VALUE", "FORMULA"}, cobra.ShellCompDirectiveNoFileComp
	})
	webAppCmd.AddCommand(webAppBatchGetCmd)
}
