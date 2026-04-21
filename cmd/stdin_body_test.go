package cmd

import (
	"maps"
	"strings"
	"testing"

	"mpu/internal/defaults"
)

const stdinTestSID = "SSID-STDIN-TEST"

// runIn sets rootCmd stdin to the given string and executes args.
func runIn(stdin string, args ...string) error {
	rootCmd.SetIn(strings.NewReader(stdin))
	return run(args...)
}

func stdinSetup(t *testing.T, extraDefaults defaults.Values) (home string, mock *mockClient) {
	t.Helper()
	home, mock = setupTest(t)
	d := defaults.Values{"spreadsheet-id": stdinTestSID}
	maps.Copy(d, extraDefaults)
	writeConfig(t, home, defaults.Config{Protected: false, Defaults: d})
	return
}

// TestStdinBodySet — set command reads JSON body from stdin when not provided as arg.
func TestStdinBodySet(t *testing.T) {
	_, mock := stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	if err := runIn(`[{"col1":"val1"}]`, "webApp", "set"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	req := mock.lastRequest()
	if req["action"] != "spreadsheets/data/replace" {
		t.Errorf("expected replace action, got %v", req["action"])
	}
	if req["ssId"] != stdinTestSID {
		t.Errorf("expected ssId %s, got %v", stdinTestSID, req["ssId"])
	}
}

// TestStdinBodySetExplicitArgWins — explicit body arg takes precedence over stdin.
func TestStdinBodySetExplicitArgWins(t *testing.T) {
	_, mock := stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	explicit := `[{"col1":"explicit"}]`
	if err := runIn(`[{"col1":"from_stdin"}]`, "webApp", "set", explicit); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	req := mock.lastRequest()
	items, _ := req["dataItems"].([]any)
	if len(items) == 0 {
		t.Fatalf("expected dataItems, got %v", req)
	}
	row, _ := items[0].(map[string]any)
	if row["col1"] != "explicit" {
		t.Errorf("explicit body should win over stdin, got %v", row["col1"])
	}
}

// TestStdinBodySetEmptyErrors — empty stdin produces an error when body arg is omitted.
func TestStdinBodySetEmptyErrors(t *testing.T) {
	stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	if err := runIn("", "webApp", "set"); err == nil {
		t.Fatal("expected error when body and stdin are both empty")
	}
}

// TestStdinBodyInsert — insert command reads body from stdin.
func TestStdinBodyInsert(t *testing.T) {
	_, mock := stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	if err := runIn(`[{"col1":"val1"}]`, "webApp", "insert"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.lastRequest()["action"] != "spreadsheets/data/insert" {
		t.Errorf("expected insert action, got %v", mock.lastRequest()["action"])
	}
}

// TestStdinBodyBatchUpdate — batch-update reads body from stdin.
func TestStdinBodyBatchUpdate(t *testing.T) {
	_, mock := stdinSetup(t, nil)

	body := `[{"sheetName":"Sheet1","dataRowFirst":3,"values":[["a","b"]]}]`
	if err := runIn(body, "webApp", "batch-update"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.lastRequest()["action"] != "spreadsheets/data/batchUpdate" {
		t.Errorf("expected batchUpdate action, got %v", mock.lastRequest()["action"])
	}
}

// TestStdinBodyValuesUpdate — values-update reads body from stdin.
func TestStdinBodyValuesUpdate(t *testing.T) {
	_, mock := stdinSetup(t, nil)

	body := `{"valueInputOption":"USER_ENTERED","data":[{"range":"Sheet1!A1","values":[["hello"]]}]}`
	if err := runIn(body, "webApp", "values-update"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.lastRequest()["action"] != "spreadsheets/values/batchUpdate" {
		t.Errorf("expected values batchUpdate, got %v", mock.lastRequest()["action"])
	}
}

// TestStdinBodyProtection — protection reads body from stdin.
func TestStdinBodyProtection(t *testing.T) {
	_, mock := stdinSetup(t, nil)

	body := `[{"sheetName":"Sheet1","protectedRanges":[{"editors":["a@b.c"]}]}]`
	if err := runIn(body, "webApp", "protection"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.lastRequest()["action"] != "spreadsheets/sheets/protection/set" {
		t.Errorf("expected protection action, got %v", mock.lastRequest()["action"])
	}
}

// TestStdinBodyUpsert — upsert reads body from stdin.
func TestStdinBodyUpsert(t *testing.T) {
	_, mock := stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	body := `[{"id":1,"name":"Alice"}]`
	if err := runIn(body, "webApp", "upsert", "--key", "id"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// upsert does GET then SET; last request is the replace
	if mock.lastRequest()["action"] != "spreadsheets/data/replace" {
		t.Errorf("expected replace action from upsert, got %v", mock.lastRequest()["action"])
	}
}

// TestStdinBodyWithWhitespace — leading/trailing whitespace in stdin is trimmed.
func TestStdinBodyWithWhitespace(t *testing.T) {
	_, mock := stdinSetup(t, defaults.Values{"sheet-name": "Sheet1"})

	body := "  \n[{\"col1\":\"val1\"}]\n  "
	if err := runIn(body, "webApp", "set"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mock.lastRequest()["action"] != "spreadsheets/data/replace" {
		t.Errorf("expected replace action, got %v", mock.lastRequest()["action"])
	}
}
