package cmd

import (
	"encoding/json"
	"fmt"

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

		// FORMATTED_VALUE is locale- and format-dependent; we never store
		// it in the per-cell cache. Pass straight through to the API.
		if vro == "FORMATTED_VALUE" {
			return batchGetDirect(c, sid, ranges, vro)
		}

		wantValue := vro == "UNFORMATTED_VALUE"
		wantFormula := vro == "FORMULA"
		if !wantValue && !wantFormula {
			// Unknown render option — fall back to pass-through so we
			// don't silently misrepresent an unrecognised value.
			return batchGetDirect(c, sid, ranges, vro)
		}

		merged, err := sheetFetch{
			spreadsheetID: sid,
			ranges:        ranges,
			wantValue:     wantValue,
			wantFormula:   wantFormula,
		}.run(currentConfig, c)
		if err != nil {
			return err
		}

		// Reconstruct the plain batchGet response shape from the merged
		// output: one valueRange per requested range, values matrix
		// filled with the selected render. FORMULA prefers stored
		// formulas and falls back to the value when no formula exists —
		// same semantics as the Sheets API.
		resp := batchGetResult{
			SpreadsheetID: sid,
			ValueRanges:   make([]valueRange, len(merged)),
		}
		for i, mr := range merged {
			vr := valueRange{Range: mr.Range, MajorDimension: "ROWS"}
			vr.Values = make([][]any, len(mr.Values))
			for r, row := range mr.Values {
				vr.Values[r] = make([]any, len(row))
				for c, cell := range row {
					if wantFormula && cell.F != "" {
						vr.Values[r][c] = cell.F
					} else {
						vr.Values[r][c] = cell.V
					}
				}
			}
			resp.ValueRanges[i] = vr
		}
		data, err := json.Marshal(resp)
		if err != nil {
			return fmt.Errorf("marshal: %w", err)
		}
		printRaw(data)
		return nil
	},
}

// batchGetDirect performs a single API call, skipping the per-cell
// cache entirely. Used for FORMATTED_VALUE and unknown render options.
func batchGetDirect(c webapp.Client, sid string, ranges []string, vro string) error {
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
}

func init() {
	addSpreadsheetFlag(webAppBatchGetCmd)
	addSheetNameFlag(webAppBatchGetCmd)
	webAppBatchGetCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppBatchGetCmd.Flags().String("value-render", "UNFORMATTED_VALUE",
		"value render option: UNFORMATTED_VALUE, FORMATTED_VALUE (bypasses cache), FORMULA")
	_ = webAppBatchGetCmd.RegisterFlagCompletionFunc("value-render", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return []string{"UNFORMATTED_VALUE", "FORMATTED_VALUE", "FORMULA"}, cobra.ShellCompDirectiveNoFileComp
	})
	webAppCmd.AddCommand(webAppBatchGetCmd)
}
