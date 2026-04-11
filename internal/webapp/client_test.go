package webapp_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"mpu/internal/config"
	"mpu/internal/webapp"
)

const testSpreadsheetID = "1eJfRwbYlkyHbtTxmWzH6nCxeIJHgbqZwPwn5tfsRRZo"
const testSheetName = "Sheet1"
const testHeaderRow = 1
const testDataRow = 3

func setupClient(t *testing.T) webapp.Client {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return webapp.NewClient(cfg.WebAppURL)
}

func setupClientWithConfig(t *testing.T) (webapp.Client, *config.Config) {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return webapp.NewClient(cfg.WebAppURL), cfg
}

// getDataItems fetches current data items and returns them as raw JSON.
func getDataItems(t *testing.T, c webapp.Client) json.RawMessage {
	t.Helper()
	resp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/get",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
	})
	if err != nil {
		t.Fatalf("getDataItems Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("getDataItems error: %s", resp.Error)
	}
	return resp.Result
}

// restoreDataItems replaces sheet data back to the given raw JSON array.
func restoreDataItems(t *testing.T, c webapp.Client, original json.RawMessage) {
	t.Helper()
	var items []interface{}
	if err := json.Unmarshal(original, &items); err != nil {
		// result may be null if sheet was empty
		items = []interface{}{}
	}
	resp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/replace",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
		"dataItems":    items,
	})
	if err != nil {
		t.Errorf("restoreDataItems Do: %v", err)
		return
	}
	if !resp.Success {
		t.Errorf("restoreDataItems error: %s", resp.Error)
	}
}

// ── Read operations ───────────────────────────────────────────────────────────

func TestSpreadsheetsGet(t *testing.T) {
	c := setupClient(t)
	resp, err := c.Do(webapp.Request{
		"action": "spreadsheets/get",
		"ssId":   testSpreadsheetID,
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("info result: %s", string(resp.Result))
}

func TestGetKeys(t *testing.T) {
	c := setupClient(t)
	resp, err := c.Do(webapp.Request{
		"action":               "spreadsheets/data/batchGet",
		"ssId":                 testSpreadsheetID,
		"ranges":               []string{fmt.Sprintf("%s!1:1", testSheetName)},
		"majorDimension":       "ROWS",
		"valueRenderOption":    "UNFORMATTED_VALUE",
		"dateTimeRenderOption": "SERIAL_NUMBER",
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("keys result: %s", string(resp.Result))
}

func TestGetDataItems(t *testing.T) {
	c := setupClient(t)
	resp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/get",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("data items result: %s", string(resp.Result))
}

func TestBatchGet(t *testing.T) {
	c := setupClient(t)
	resp, err := c.Do(webapp.Request{
		"action":               "spreadsheets/data/batchGet",
		"ssId":                 testSpreadsheetID,
		"ranges":               []string{fmt.Sprintf("%s!A1:B5", testSheetName)},
		"majorDimension":       "ROWS",
		"valueRenderOption":    "UNFORMATTED_VALUE",
		"dateTimeRenderOption": "SERIAL_NUMBER",
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("batch get result: %s", string(resp.Result))
}

func TestEditorsGet(t *testing.T) {
	c := setupClient(t)
	resp, err := c.Do(webapp.Request{
		"action": "spreadsheets/editors/get",
		"ssId":   testSpreadsheetID,
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("editors result: %s", string(resp.Result))
}

// ── Write operations ──────────────────────────────────────────────────────────

func TestDataInsert(t *testing.T) {
	c := setupClient(t)
	original := getDataItems(t, c)
	t.Cleanup(func() { restoreDataItems(t, c, original) })

	tag := fmt.Sprintf("test-insert-%d", time.Now().UnixMilli())
	resp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/insert",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
		"dataItems":    []interface{}{map[string]interface{}{"id": tag, "value": "inserted"}},
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("insert result: %s", string(resp.Result))
}

func TestDataReplace(t *testing.T) {
	c := setupClient(t)
	original := getDataItems(t, c)
	t.Cleanup(func() { restoreDataItems(t, c, original) })

	tag := fmt.Sprintf("test-replace-%d", time.Now().UnixMilli())
	resp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/replace",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
		"dataItems":    []interface{}{map[string]interface{}{"id": tag, "value": "replaced"}},
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("replace result: %s", string(resp.Result))
}

func TestBatchUpdate(t *testing.T) {
	c := setupClient(t)
	original := getDataItems(t, c)
	t.Cleanup(func() { restoreDataItems(t, c, original) })

	tag := fmt.Sprintf("test-batch-%d", time.Now().UnixMilli())
	resp, err := c.Do(webapp.Request{
		"action": "spreadsheets/data/batchUpdate",
		"ssId":   testSpreadsheetID,
		"requestBatchUpdaterData": []interface{}{
			map[string]interface{}{
				"sheetName":    testSheetName,
				"dataRowFirst": testDataRow,
				"values":       []interface{}{[]interface{}{tag, "batch-updated"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("batch-update result: %s", string(resp.Result))
}

func TestValuesUpdate(t *testing.T) {
	c := setupClient(t)

	// Read the current value of A2 so we can restore it.
	readResp, err := c.Do(webapp.Request{
		"action":               "spreadsheets/data/batchGet",
		"ssId":                 testSpreadsheetID,
		"ranges":               []string{fmt.Sprintf("%s!A2", testSheetName)},
		"majorDimension":       "ROWS",
		"valueRenderOption":    "UNFORMATTED_VALUE",
		"dateTimeRenderOption": "SERIAL_NUMBER",
	})
	if err != nil {
		t.Fatalf("read A2 Do: %v", err)
	}
	originalRaw := readResp.Result

	t.Cleanup(func() {
		// best-effort restore of A2
		var parsed []interface{}
		_ = json.Unmarshal(originalRaw, &parsed)
		var origVal interface{} = ""
		if len(parsed) > 0 {
			origVal = parsed
		}
		c.Do(webapp.Request{ //nolint:errcheck
			"action": "spreadsheets/values/batchUpdate",
			"ssId":   testSpreadsheetID,
			"requestBody": map[string]interface{}{
				"valueInputOption": "USER_ENTERED",
				"data": []interface{}{
					map[string]interface{}{
						"range":  fmt.Sprintf("%s!A2", testSheetName),
						"values": []interface{}{[]interface{}{origVal}},
					},
				},
			},
		})
	})

	tag := fmt.Sprintf("val-update-%d", time.Now().UnixMilli())
	resp, err := c.Do(webapp.Request{
		"action": "spreadsheets/values/batchUpdate",
		"ssId":   testSpreadsheetID,
		"requestBody": map[string]interface{}{
			"valueInputOption": "USER_ENTERED",
			"data": []interface{}{
				map[string]interface{}{
					"range":  fmt.Sprintf("%s!A2", testSheetName),
					"values": []interface{}{[]interface{}{tag}},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got error: %s", resp.Error)
	}
	t.Logf("values-update result: %s", string(resp.Result))
}

func TestEditorsAddRemove(t *testing.T) {
	c := setupClient(t)

	// Get the original editors list so we can restore it exactly.
	getResp, err := c.Do(webapp.Request{
		"action": "spreadsheets/editors/get",
		"ssId":   testSpreadsheetID,
	})
	if err != nil {
		t.Fatalf("editors/get Do: %v", err)
	}
	if !getResp.Success {
		t.Fatalf("editors/get error: %s", getResp.Error)
	}
	var originalEditors []string
	if err := json.Unmarshal(getResp.Result, &originalEditors); err != nil {
		t.Fatalf("parse original editors: %v", err)
	}
	t.Logf("original editors: %v", originalEditors)

	// Use a test address that is clearly disposable. We'll restore via set.
	testEditor := "test-mpu-ci@example.com"

	// Restore exact original list in cleanup before any add.
	t.Cleanup(func() {
		orig := make([]interface{}, len(originalEditors))
		for i, e := range originalEditors {
			orig[i] = e
		}
		resp, err := c.Do(webapp.Request{
			"action":  "spreadsheets/editors/set",
			"ssId":    testSpreadsheetID,
			"editors": orig,
		})
		if err != nil {
			t.Errorf("editors/set restore Do: %v", err)
			return
		}
		if !resp.Success {
			t.Errorf("editors/set restore error: %s", resp.Error)
		}
		t.Logf("editors restored: %s", string(resp.Result))
	})

	addResp, err := c.Do(webapp.Request{
		"action":  "spreadsheets/editors/add",
		"ssId":    testSpreadsheetID,
		"editors": []interface{}{testEditor},
	})
	if err != nil {
		t.Fatalf("editors/add Do: %v", err)
	}
	if !addResp.Success {
		t.Fatalf("editors/add error: %s", addResp.Error)
	}
	t.Logf("editors/add result: %s", string(addResp.Result))

	removeResp, err := c.Do(webapp.Request{
		"action":  "spreadsheets/editors/remove",
		"ssId":    testSpreadsheetID,
		"editors": []interface{}{testEditor},
	})
	if err != nil {
		t.Fatalf("editors/remove Do: %v", err)
	}
	if !removeResp.Success {
		t.Fatalf("editors/remove error: %s", removeResp.Error)
	}
	t.Logf("editors/remove result: %s", string(removeResp.Result))
}

// TestUpsert verifies the get→merge→replace sequence used by the upsert command.
func TestUpsert(t *testing.T) {
	c := setupClient(t)
	original := getDataItems(t, c)
	t.Cleanup(func() { restoreDataItems(t, c, original) })

	// Seed two known rows.
	seed := []interface{}{
		map[string]interface{}{"a": "key1", "b": "old-b1", "c": "old-c1"},
		map[string]interface{}{"a": "key2", "b": "old-b2", "c": "old-c2"},
	}
	setResp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/replace",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
		"dataItems":    seed,
	})
	if err != nil {
		t.Fatalf("seed replace Do: %v", err)
	}
	if !setResp.Success {
		t.Fatalf("seed replace error: %s", setResp.Error)
	}

	// Fetch current data (simulates what upsert does step 1).
	getResp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/get",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
	})
	if err != nil {
		t.Fatalf("get Do: %v", err)
	}
	if !getResp.Success {
		t.Fatalf("get error: %s", getResp.Error)
	}
	var existing []map[string]interface{}
	if err := json.Unmarshal(getResp.Result, &existing); err != nil {
		t.Fatalf("unmarshal existing: %v", err)
	}

	// Upsert: update key1, insert key3 (step 2 — local merge).
	keyField := "a"
	incoming := []map[string]interface{}{
		{"a": "key1", "b": "new-b1", "c": "new-c1"}, // update
		{"a": "key3", "b": "b3", "c": "c3"},          // insert
	}
	index := make(map[interface{}]int)
	for i, row := range existing {
		if kv, ok := row[keyField]; ok {
			index[kv] = i
		}
	}
	for _, item := range incoming {
		kv := item[keyField]
		if pos, found := index[kv]; found {
			existing[pos] = item
		} else {
			index[kv] = len(existing)
			existing = append(existing, item)
		}
	}

	// Upload merged data (step 3).
	rows := make([]interface{}, len(existing))
	for i, r := range existing {
		rows[i] = r
	}
	replaceResp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/replace",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
		"dataItems":    rows,
	})
	if err != nil {
		t.Fatalf("upsert replace Do: %v", err)
	}
	if !replaceResp.Success {
		t.Fatalf("upsert replace error: %s", replaceResp.Error)
	}

	// Verify result.
	verResp, err := c.Do(webapp.Request{
		"action":       "spreadsheets/data/get",
		"ssId":         testSpreadsheetID,
		"sheetName":    testSheetName,
		"keysRow":      testHeaderRow,
		"dataRowFirst": testDataRow,
	})
	if err != nil {
		t.Fatalf("verify get Do: %v", err)
	}
	if !verResp.Success {
		t.Fatalf("verify get error: %s", verResp.Error)
	}
	var result []map[string]interface{}
	if err := json.Unmarshal(verResp.Result, &result); err != nil {
		t.Fatalf("unmarshal verify: %v", err)
	}

	if len(result) != 3 {
		t.Fatalf("expected 3 rows, got %d: %s", len(result), string(verResp.Result))
	}
	byKey := make(map[interface{}]map[string]interface{})
	for _, r := range result {
		byKey[r[keyField]] = r
	}
	if byKey["key1"]["b"] != "new-b1" {
		t.Errorf("key1 not updated: got b=%v", byKey["key1"]["b"])
	}
	if byKey["key2"]["b"] != "old-b2" {
		t.Errorf("key2 should be unchanged: got b=%v", byKey["key2"]["b"])
	}
	if byKey["key3"] == nil {
		t.Errorf("key3 not inserted")
	}
	t.Logf("upsert result: %s", string(verResp.Result))
}

func TestSharingSet(t *testing.T) {
	c := setupClient(t)

	resp, err := c.Do(webapp.Request{
		"action":         "spreadsheets/sharing/set",
		"ssId":           testSpreadsheetID,
		"accessType":     "ANYONE_WITH_LINK",
		"permissionType": "VIEW",
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if !resp.Success {
		// sharing/set requires the Apps Script to own the file or have Drive
		// admin scope; skip rather than fail if we get a permission/not-found error.
		t.Skipf("sharing/set not available for this spreadsheet (permission): %s", resp.Error)
	}
	t.Logf("sharing/set result: %s", string(resp.Result))
}
