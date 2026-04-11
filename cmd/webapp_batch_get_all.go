package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

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
		A string `json:"a"`
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

		startCol, startRow := parseRangeStart(vr.Range)

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

				addr := colToLetters(startCol+c) + strconv.Itoa(startRow+r)
				merged[r][c] = cell{A: addr, V: v, F: formula}
			}
		}
		out[i] = mergedRange{Range: vr.Range, Values: merged}
	}

	return out, nil
}

// parseRangeStart extracts the starting column (0-based) and row (1-based)
// from a range string like "Sheet1!A1:Z100" or "A1:B2".
// Returns (0, 1) if parsing fails.
func parseRangeStart(rangeStr string) (col, row int) {
	// Strip sheet name prefix (e.g. "'Sheet 1'!A1:B2" → "A1:B2")
	if idx := strings.LastIndex(rangeStr, "!"); idx >= 0 {
		rangeStr = rangeStr[idx+1:]
	}
	// Take only the start cell (before ":")
	if idx := strings.Index(rangeStr, ":"); idx >= 0 {
		rangeStr = rangeStr[:idx]
	}
	// Split into letters and digits
	i := 0
	for i < len(rangeStr) && rangeStr[i] >= 'A' && rangeStr[i] <= 'Z' {
		i++
	}
	if i == 0 || i == len(rangeStr) {
		return 0, 1
	}
	letters := rangeStr[:i]
	num, err := strconv.Atoi(rangeStr[i:])
	if err != nil || num < 1 {
		return 0, 1
	}
	// Convert column letters to 0-based index: A=0, B=1, ..., Z=25, AA=26
	col = 0
	for _, ch := range letters {
		col = col*26 + int(ch-'A') + 1
	}
	col-- // make 0-based
	return col, num
}

// colToLetters converts a 0-based column index to spreadsheet letters: 0→A, 25→Z, 26→AA.
func colToLetters(col int) string {
	result := ""
	col++ // 1-based
	for col > 0 {
		col--
		result = string(rune('A'+col%26)) + result
		col /= 26
	}
	return result
}

func init() {
	addSpreadsheetFlag(webAppBatchGetAllCmd)
	addSheetNameFlag(webAppBatchGetAllCmd)
	webAppBatchGetAllCmd.Flags().StringArrayP("range", "r", nil, "range(s) to fetch (repeatable)")
	webAppCmd.AddCommand(webAppBatchGetAllCmd)
}
