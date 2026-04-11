package webapp_test

import (
	"testing"

	"mpu/internal/config"
	"mpu/internal/webapp"
)

const testSpreadsheetID = "1eJfRwbYlkyHbtTxmWzH6nCxeIJHgbqZwPwn5tfsRRZo"

func setupClient(t *testing.T) webapp.Client {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return webapp.NewClient(cfg.WebAppURL)
}

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
		"ranges":               []string{"Sheet1!1:1"},
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
		"sheetName":    "Sheet1",
		"keysRow":      1,
		"dataRowFirst": 3,
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
		"ranges":               []string{"Sheet1!A1:B5"},
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
