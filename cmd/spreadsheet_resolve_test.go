package cmd

import (
	"testing"

	"mpu/internal/cache"
	"mpu/internal/defaults"
)

func TestSortActiveFirst(t *testing.T) {
	rows := []cache.SpreadsheetRow{
		{SpreadsheetID: "a", IsActive: false},
		{SpreadsheetID: "b", IsActive: true},
		{SpreadsheetID: "c", IsActive: false},
		{SpreadsheetID: "d", IsActive: true},
		{SpreadsheetID: "e", IsActive: true},
	}
	sortActiveFirst(rows)

	// Active first, preserving order within each group.
	wantOrder := []string{"b", "d", "e", "a", "c"}
	for i, r := range rows {
		if r.SpreadsheetID != wantOrder[i] {
			t.Errorf("index %d: got %s, want %s", i, r.SpreadsheetID, wantOrder[i])
		}
	}
}

func TestSortActiveFirst_AllActive(t *testing.T) {
	rows := []cache.SpreadsheetRow{
		{SpreadsheetID: "a", IsActive: true},
		{SpreadsheetID: "b", IsActive: true},
	}
	sortActiveFirst(rows)
	if rows[0].SpreadsheetID != "a" || rows[1].SpreadsheetID != "b" {
		t.Errorf("order changed for all-active: %v", rows)
	}
}

func TestSortActiveFirst_Empty(t *testing.T) {
	var rows []cache.SpreadsheetRow
	sortActiveFirst(rows) // should not panic
}

func TestRuneLen(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"hello", 5},
		{"привет", 6},
		{"abc123", 6},
		{"", 0},
		{"Cool Flaps | 10X WB", 19},
	}
	for _, tt := range tests {
		if got := runeLen(tt.input); got != tt.want {
			t.Errorf("runeLen(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestPadRight(t *testing.T) {
	tests := []struct {
		input string
		width int
		want  string
	}{
		{"hi", 5, "hi   "},
		{"привет", 10, "привет    "},
		{"exact", 5, "exact"},
		{"longer", 3, "longer"}, // no truncation
		{"", 3, "   "},
	}
	for _, tt := range tests {
		got := padRight(tt.input, tt.width)
		if got != tt.want {
			t.Errorf("padRight(%q, %d) = %q, want %q", tt.input, tt.width, got, tt.want)
		}
	}
}

func TestIsJSONArg(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{`[{"a":1}]`, true},
		{`{"a":1}`, true},
		{`54`, false},
		{`some_name`, false},
		{`Cool Flaps`, false},
		{``, false},
	}
	for _, tt := range tests {
		got := isJSONArg(tt.input)
		if got != tt.want {
			t.Errorf("isJSONArg(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("short", 10); got != "short" {
		t.Errorf("truncate short: got %q", got)
	}
	if got := truncate("a very long string indeed", 10); got != "a very ..." {
		t.Errorf("truncate long: got %q", got)
	}
}

func TestResolveSpreadsheetID_ExplicitFlagWins(t *testing.T) {
	home, _ := setupTest(t)
	_ = home

	// Pre-populate spreadsheets in cache to ensure flag still wins.
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("open cache: %v", err)
	}
	db.InsertSpreadsheetChunk([]cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "from-cache", Title: "Cached", Version: 1},
	})
	db.Close()

	// Run with explicit -s flag.
	if err := run("webApp", "get", "-s", "explicit-id", "-n", "Sheet1"); err != nil {
		t.Fatalf("run: %v", err)
	}

	cfg := readConfig(t, home)
	if cfg.Defaults["spreadsheet-id"] != "explicit-id" {
		t.Errorf("saved spreadsheet-id: got %v, want explicit-id", cfg.Defaults["spreadsheet-id"])
	}
}

func TestResolveSpreadsheetID_FallsBackToDefault(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Defaults: defaults.Values{
			"spreadsheet-id": "saved-sid",
			"sheet-name":     "Sheet1",
		},
	})

	if err := run("webApp", "get"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "saved-sid" {
		t.Errorf("ssId: got %v, want saved-sid", req["ssId"])
	}
}

func TestResolveSpreadsheetID_NoFlagNoDefaultErrors(t *testing.T) {
	setupTest(t)

	// No -s, no positional arg, no saved default, but -n is provided.
	currentConfig.Defaults["sheet-name"] = "Sheet1"
	err := run("webApp", "get", "-n", "Sheet1")
	if err == nil {
		t.Fatal("expected error when no spreadsheet-id source available")
	}
}

func TestResolveSpreadsheetID_NumericArgClientLookup_AutoSelect(t *testing.T) {
	home, mock := setupTest(t)
	_ = home

	// Populate cache with exactly one spreadsheet for client 42.
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("open cache: %v", err)
	}
	db.InsertSpreadsheetChunk([]cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 42, SpreadsheetID: "the-only-one", Title: "Only Sheet", Version: 1},
	})
	db.Close()

	if err := run("webApp", "get", "42", "-n", "Sheet1"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "the-only-one" {
		t.Errorf("ssId: got %v, want the-only-one", req["ssId"])
	}

	// Check it saved to defaults.
	cfg := readConfig(t, home)
	if cfg.Defaults["spreadsheet-id"] != "the-only-one" {
		t.Errorf("saved spreadsheet-id: got %v", cfg.Defaults["spreadsheet-id"])
	}
}

func TestResolveSpreadsheetID_NumericArgNotFound(t *testing.T) {
	setupTest(t)

	// Populate cache with a different client.
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("open cache: %v", err)
	}
	db.InsertSpreadsheetChunk([]cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "ss1", Title: "Other", Version: 1},
	})
	db.Close()

	currentConfig.Defaults["sheet-name"] = "Sheet1"
	err = run("webApp", "get", "999")
	if err == nil {
		t.Fatal("expected error for non-existent client ID")
	}
}

func TestResolveSpreadsheetID_NoCacheErrors(t *testing.T) {
	setupTest(t)

	// Empty cache (no spreadsheets at all).
	currentConfig.Defaults["sheet-name"] = "Sheet1"
	err := run("webApp", "get", "42")
	if err == nil {
		t.Fatal("expected error with empty spreadsheets cache")
	}
}

func TestResolveSpreadsheetID_SetCommandWithBodyArg(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"sheet-name": "Sheet1"},
	})

	// Populate cache with one spreadsheet for client 42.
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("open cache: %v", err)
	}
	db.InsertSpreadsheetChunk([]cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 42, SpreadsheetID: "set-test-id", Title: "Set Test", Version: 1},
	})
	db.Close()

	// `set` command with positional query + JSON body.
	if err := run("webApp", "set", "42", `[{"col1":"val1"}]`); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "set-test-id" {
		t.Errorf("ssId: got %v, want set-test-id", req["ssId"])
	}

	cfg := readConfig(t, home)
	if cfg.Defaults["spreadsheet-id"] != "set-test-id" {
		t.Errorf("saved spreadsheet-id: got %v", cfg.Defaults["spreadsheet-id"])
	}
}

func TestResolveSpreadsheetID_SetCommandWithExplicitSFlag(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"sheet-name": "Sheet1"},
	})

	// `set` with -s flag and JSON body — no spreadsheet lookup needed.
	if err := run("webApp", "set", "-s", "explicit", "-n", "Sheet1", `[{"col1":"val1"}]`); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "explicit" {
		t.Errorf("ssId: got %v, want explicit", req["ssId"])
	}
}

func TestResolveSpreadsheetID_SetCommandJSONOnlyFallsToDefault(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults: defaults.Values{
			"spreadsheet-id": "default-sid",
			"sheet-name":     "Sheet1",
		},
	})

	// JSON body looks like JSON, so it should NOT be treated as a query.
	if err := run("webApp", "set", `[{"col1":"val1"}]`); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "default-sid" {
		t.Errorf("ssId: got %v, want default-sid", req["ssId"])
	}
}
