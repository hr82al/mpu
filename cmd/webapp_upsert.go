package cmd

import (
	"encoding/json"
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppUpsertCmd = &cobra.Command{
	Use:   "upsert <json-array>",
	Short: "Upsert data items into a sheet by key field",
	Args:  cobra.RangeArgs(1, 2),
	Example: `  mpu webApp upsert -s <id> -n Sheet1 --key id '[{"id":1,"name":"updated"},{"id":99,"name":"new"}]'`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, bodyArgs, err := resolveSpreadsheetID(cmd, args)
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "sheet-name")
		if err != nil {
			return err
		}
		keyField, err := requireFlag(cmd, "key")
		if err != nil {
			return err
		}
		headerRow := getIntFlag(cmd, "header-row")
		dataRow := getIntFlag(cmd, "data-row")

		var incoming []map[string]interface{}
		if err := json.Unmarshal([]byte(bodyArgs[0]), &incoming); err != nil {
			return fmt.Errorf("invalid JSON array: %w", err)
		}
		if len(incoming) == 0 {
			return fmt.Errorf("input array is empty")
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		// 1. Fetch current data.
		getResp, err := c.Do(webapp.Request{
			"action":       "spreadsheets/data/get",
			"ssId":         sid,
			"sheetName":    name,
			"keysRow":      headerRow,
			"dataRowFirst": dataRow,
		})
		if err != nil {
			return err
		}
		if err := checkResp(getResp); err != nil {
			return err
		}

		var existing []map[string]interface{}
		if err := json.Unmarshal(getResp.Result, &existing); err != nil {
			// Sheet may be empty (null result).
			existing = nil
		}

		// 2. Build index: keyValue → position in existing slice.
		index := make(map[interface{}]int, len(existing))
		for i, row := range existing {
			if kv, ok := row[keyField]; ok {
				index[kv] = i
			}
		}

		// 3. Apply upsert locally.
		updated := 0
		inserted := 0
		for _, item := range incoming {
			kv, hasKey := item[keyField]
			if !hasKey {
				return fmt.Errorf("item missing key field %q: %v", keyField, item)
			}
			if pos, found := index[kv]; found {
				existing[pos] = item
				updated++
			} else {
				index[kv] = len(existing)
				existing = append(existing, item)
				inserted++
			}
		}

		// 4. Upload merged data back.
		rows := make([]interface{}, len(existing))
		for i, r := range existing {
			rows[i] = r
		}
		setResp, err := c.Do(webapp.Request{
			"action":       "spreadsheets/data/replace",
			"ssId":         sid,
			"sheetName":    name,
			"keysRow":      headerRow,
			"dataRowFirst": dataRow,
			"dataItems":    rows,
		})
		if err != nil {
			return err
		}
		if err := checkResp(setResp); err != nil {
			return err
		}

		fmt.Printf("upsert done: %d updated, %d inserted\n", updated, inserted)
		return nil
	},
}

func init() {
	addSpreadsheetFlag(webAppUpsertCmd)
	addSheetNameFlag(webAppUpsertCmd)
	webAppUpsertCmd.Flags().String("key", "", "key field name for matching rows")
	webAppUpsertCmd.Flags().Int("header-row", 1, "header row number")
	webAppUpsertCmd.Flags().Int("data-row", 3, "first data row number")
	webAppCmd.AddCommand(webAppUpsertCmd)
}
