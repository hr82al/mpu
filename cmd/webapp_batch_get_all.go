package cmd

import (
	"github.com/spf13/cobra"
)

var webAppBatchGetAllCmd = &cobra.Command{
	Use:   "batch-get-all",
	Args:  cobra.MaximumNArgs(1),
	Short: "Batch get values and formulas from multiple ranges",
	Example: `  mpu webApp batch-get-all -s <id> -r 'Sheet1!A1:B2'
  mpu batch-get-all -s <id> -n UNIT`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, _, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}
		ranges, err := resolveRanges(cmd)
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		out, err := sheetFetch{
			spreadsheetID: sid,
			ranges:        ranges,
			wantValue:     true,
			wantFormula:   true,
		}.run(currentConfig, c)
		if err != nil {
			return err
		}
		printJSON(out)
		return nil
	},
}

// batchGetResult mirrors the Sheets API batchGet response. Shared with
// the bridge in sheet_cache.go and the batch-get command.
type batchGetResult struct {
	SpreadsheetID string       `json:"spreadsheetId"`
	ValueRanges   []valueRange `json:"valueRanges"`
}

type valueRange struct {
	Range          string  `json:"range"`
	MajorDimension string  `json:"majorDimension"`
	Values         [][]any `json:"values"`
}

func init() {
	addSpreadsheetFlag(webAppBatchGetAllCmd)
	addSheetNameFlag(webAppBatchGetAllCmd)
	webAppBatchGetAllCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppCmd.AddCommand(webAppBatchGetAllCmd)
}
