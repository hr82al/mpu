package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"mpu/internal/cache"
	"mpu/internal/defaults"
)

// captureStdout redirects os.Stdout during fn and returns what was written.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	w.Close()
	os.Stdout = old
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(r)
	return buf.String()
}

// ── resolveClientID ───────────────────────────────────────────────────────────

func TestResolveClientID_ExplicitArg(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	id, err := resolveClientID([]string{"42"})
	if err != nil {
		t.Fatalf("resolveClientID: %v", err)
	}
	if id != 42 {
		t.Errorf("got %d, want 42", id)
	}

	// Must be saved to defaults as float64.
	v, ok := currentConfig.Defaults["client-id"]
	if !ok {
		t.Fatal("client-id not saved to defaults")
	}
	if v != float64(42) {
		t.Errorf("defaults[client-id]: got %v (%T), want 42 (float64)", v, v)
	}
}

func TestResolveClientID_FromDefaults(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: defaults.Values{"client-id": float64(99)}}

	id, err := resolveClientID(nil)
	if err != nil {
		t.Fatalf("resolveClientID: %v", err)
	}
	if id != 99 {
		t.Errorf("got %d, want 99", id)
	}
}

func TestResolveClientID_MissingErrors(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	_, err := resolveClientID(nil)
	if err == nil {
		t.Fatal("expected error when no arg and no default, got nil")
	}
}

func TestResolveClientID_InvalidArg(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	_, err := resolveClientID([]string{"notanumber"})
	if err == nil {
		t.Fatal("expected error for non-numeric arg, got nil")
	}
}

func TestResolveClientID_InvalidDefault(t *testing.T) {
	setupTest(t)
	// Stored as string (invalid type).
	currentConfig = defaults.Config{Defaults: defaults.Values{"client-id": "bad"}}

	_, err := resolveClientID(nil)
	if err == nil {
		t.Fatal("expected error for invalid default type, got nil")
	}
}

func TestResolveClientID_ZeroDefault(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: defaults.Values{"client-id": float64(0)}}

	_, err := resolveClientID(nil)
	if err == nil {
		t.Fatal("expected error for zero client-id default, got nil")
	}
}

// ── splitFields ───────────────────────────────────────────────────────────────

func TestSplitFields_Empty(t *testing.T) {
	if got := splitFields(""); len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
}

func TestSplitFields_Single(t *testing.T) {
	got := splitFields("server")
	if len(got) != 1 || got[0] != "server" {
		t.Errorf("got %v, want [server]", got)
	}
}

func TestSplitFields_Multiple(t *testing.T) {
	got := splitFields("id,server,is_active")
	want := []string{"id", "server", "is_active"}
	if len(got) != len(want) {
		t.Fatalf("len: got %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("[%d]: got %q, want %q", i, got[i], w)
		}
	}
}

func TestSplitFields_TrimsSpaces(t *testing.T) {
	got := splitFields(" id , server ")
	if len(got) != 2 || got[0] != "id" || got[1] != "server" {
		t.Errorf("got %v, want [id server]", got)
	}
}

func TestSplitFields_SkipsEmpty(t *testing.T) {
	got := splitFields("id,,server")
	if len(got) != 2 || got[0] != "id" || got[1] != "server" {
		t.Errorf("got %v, want [id server]", got)
	}
}

// ── getFieldsFlag ─────────────────────────────────────────────────────────────

func TestGetFieldsFlag_ExplicitValue(t *testing.T) {
	setupTest(t)

	// Simulate cobra having parsed --fields server (Set marks Changed=true).
	if err := clientCmd.Flags().Set("fields", "server"); err != nil {
		t.Fatalf("set flag: %v", err)
	}

	fields := getFieldsFlag(clientCmd)

	// Should be saved to defaults.
	v, ok := currentConfig.Defaults["fields"]
	if !ok {
		t.Fatal("fields not saved to defaults after explicit flag")
	}
	if v != "server" {
		t.Errorf("defaults[fields]: got %v, want server", v)
	}
	if len(fields) != 1 || fields[0] != "server" {
		t.Errorf("returned fields: got %v, want [server]", fields)
	}
}

func TestGetFieldsFlag_EmptyClearsDefault(t *testing.T) {
	setupTest(t)
	currentConfig.Defaults["fields"] = "server"

	// Simulate --fields "" explicitly passed.
	if err := clientCmd.Flags().Set("fields", ""); err != nil {
		t.Fatalf("set flag: %v", err)
	}

	_ = getFieldsFlag(clientCmd)

	v := currentConfig.Defaults["fields"]
	if v != "" {
		t.Errorf("defaults[fields]: got %v (%T), want empty string", v, v)
	}
}

func TestGetFieldsFlag_NotSetReturnsNil(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	// When --fields is not passed and not in defaults, getFieldsFlag returns nil.
	fields := getFieldsFlag(clientCmd)
	if fields != nil {
		t.Errorf("expected nil, got %v", fields)
	}
}

func TestGetFieldsFlag_LoadsFromDefaults(t *testing.T) {
	setupTest(t)
	currentConfig.Defaults["fields"] = "id,server"

	fields := getFieldsFlag(clientCmd)
	if len(fields) != 2 || fields[0] != "id" || fields[1] != "server" {
		t.Errorf("got %v, want [id server]", fields)
	}
}

// ── printClientFields ─────────────────────────────────────────────────────────

func makeTestClient() *cache.ClientRow {
	ts := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	return &cache.ClientRow{
		ID:        42,
		Server:    "sl-1",
		IsActive:  true,
		IsLocked:  false,
		IsDeleted: false,
		CreatedAt: &ts,
	}
}

func TestPrintClientFields_NoFields_FullJSON(t *testing.T) {
	var printErr error
	out := captureStdout(t, func() {
		printErr = printClientFields(makeTestClient(), nil)
	})
	if printErr != nil {
		t.Fatalf("printClientFields: %v", printErr)
	}

	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("output not valid JSON: %v — got: %s", err, out)
	}
	if m["id"] == nil {
		t.Error("full JSON should contain 'id'")
	}
}

func TestPrintClientFields_SingleField_RawValue(t *testing.T) {
	var printErr error
	out := captureStdout(t, func() {
		printErr = printClientFields(makeTestClient(), []string{"server"})
	})
	if printErr != nil {
		t.Fatalf("printClientFields: %v", printErr)
	}

	got := strings.TrimSpace(out)
	if got != "sl-1" {
		t.Errorf("got %q, want sl-1", got)
	}
}

func TestPrintClientFields_MultipleFields_JSONSubset(t *testing.T) {
	var printErr error
	out := captureStdout(t, func() {
		printErr = printClientFields(makeTestClient(), []string{"id", "server"})
	})
	if printErr != nil {
		t.Fatalf("printClientFields: %v", printErr)
	}

	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("output not valid JSON: %v — got: %s", err, out)
	}
	if len(m) != 2 {
		t.Errorf("expected 2 keys, got %d: %v", len(m), m)
	}
	if _, ok := m["id"]; !ok {
		t.Error("missing 'id'")
	}
	if _, ok := m["server"]; !ok {
		t.Error("missing 'server'")
	}
	if _, ok := m["is_active"]; ok {
		t.Error("unexpected 'is_active' in subset")
	}
}

func TestPrintClientFields_UnknownField_Error(t *testing.T) {
	err := printClientFields(makeTestClient(), []string{"nonexistent"})
	if err == nil {
		t.Fatal("expected error for unknown field, got nil")
	}
}

func TestPrintClientFields_UnknownFieldInMultiple_Error(t *testing.T) {
	err := printClientFields(makeTestClient(), []string{"id", "bogus"})
	if err == nil {
		t.Fatal("expected error for unknown field in multi-field request, got nil")
	}
}

// ── formatValue ───────────────────────────────────────────────────────────────

func TestFormatValue_String(t *testing.T) {
	if got := formatValue("hello"); got != "hello" {
		t.Errorf("got %q, want hello", got)
	}
}

func TestFormatValue_Nil(t *testing.T) {
	if got := formatValue(nil); got != "null" {
		t.Errorf("got %q, want null", got)
	}
}

func TestFormatValue_Number(t *testing.T) {
	if got := formatValue(float64(42)); got != "42" {
		t.Errorf("got %q, want 42", got)
	}
}

func TestFormatValue_Bool(t *testing.T) {
	if got := formatValue(true); got != "true" {
		t.Errorf("got %q, want true", got)
	}
}
