package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

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

		fetch := func(vro string) (*webapp.Response, error) {
			return c.Do(webapp.Request{
				"action":               "spreadsheets/values/batchGet",
				"ssId":                 sid,
				"ranges":               ranges,
				"majorDimension":       "ROWS",
				"valueRenderOption":    vro,
				"dateTimeRenderOption": "SERIAL_NUMBER",
			})
		}

		respVal, err := fetch("UNFORMATTED_VALUE")
		if err != nil {
			return err
		}
		if err := checkResp(respVal); err != nil {
			return err
		}

		respFml, err := fetch("FORMULA")
		if err != nil {
			return err
		}
		if err := checkResp(respFml); err != nil {
			return err
		}

		merged, err := mergeValuesAndFormulas(respVal.Result, respFml.Result)
		if err != nil {
			return err
		}
		printJSON(merged)
		return nil
	},
}

// batchGetResult mirrors the Sheets API batchGet response.
type batchGetResult struct {
	SpreadsheetID string       `json:"spreadsheetId"`
	ValueRanges   []valueRange `json:"valueRanges"`
}

type valueRange struct {
	Range          string `json:"range"`
	MajorDimension string `json:"majorDimension"`
	Values         [][]any `json:"values"`
}

// mergeValuesAndFormulas combines two batchGet results (values + formulas)
// into one where each cell is {"v": value, "f": formula}.
// If a cell has no formula (formula == value), "f" is "".
func mergeValuesAndFormulas(valRaw, fmlRaw json.RawMessage) (any, error) {
	var valResult, fmlResult batchGetResult
	if err := json.Unmarshal(valRaw, &valResult); err != nil {
		return nil, fmt.Errorf("parse values: %w", err)
	}
	if err := json.Unmarshal(fmlRaw, &fmlResult); err != nil {
		return nil, fmt.Errorf("parse formulas: %w", err)
	}

	type cell struct {
		V any    `json:"v"`
		F string `json:"f"`
	}

	type mergedRange struct {
		Range  string   `json:"range"`
		Values [][]cell `json:"values"`
	}

	out := make([]mergedRange, len(valResult.ValueRanges))
	for i, vr := range valResult.ValueRanges {
		var fr valueRange
		if i < len(fmlResult.ValueRanges) {
			fr = fmlResult.ValueRanges[i]
		}

		rows := max(len(vr.Values), len(fr.Values))
		merged := make([][]cell, rows)
		for r := range rows {
			var valRow, fmlRow []any
			if r < len(vr.Values) {
				valRow = vr.Values[r]
			}
			if r < len(fr.Values) {
				fmlRow = fr.Values[r]
			}

			cols := max(len(valRow), len(fmlRow))
			merged[r] = make([]cell, cols)
			for c := range cols {
				var v, f any
				if c < len(valRow) {
					v = valRow[c]
				}
				if c < len(fmlRow) {
					f = fmlRow[c]
				}

				fStr := fmt.Sprint(f)
				vStr := fmt.Sprint(v)
				formula := ""
				if fStr != vStr {
					formula = fStr
				}

				merged[r][c] = cell{V: v, F: formula}
			}
		}
		out[i] = mergedRange{Range: vr.Range, Values: merged}
	}

	return out, nil
}

func init() {
	addSpreadsheetFlag(webAppBatchGetAllCmd)
	addSheetNameFlag(webAppBatchGetAllCmd)
	webAppBatchGetAllCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppCmd.AddCommand(webAppBatchGetAllCmd)
}
