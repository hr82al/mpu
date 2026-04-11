package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"mpu/internal/defaults"
	"mpu/internal/webapp"
)

// ── mock client ───────────────────────────────────────────────────────────────

type mockClient struct {
	requests []webapp.Request
}

func (m *mockClient) Do(req webapp.Request) (*webapp.Response, error) {
	m.requests = append(m.requests, req)
	return &webapp.Response{Success: true, Result: json.RawMessage(`[]`)}, nil
}

func (m *mockClient) lastRequest() webapp.Request {
	if len(m.requests) == 0 {
		return nil
	}
	return m.requests[len(m.requests)-1]
}

// ── helpers ───────────────────────────────────────────────────────────────────

func setupTest(t *testing.T) (home string, mock *mockClient) {
	t.Helper()

	home = t.TempDir()
	t.Setenv("HOME", home)

	mock = &mockClient{}
	testClientFn = func() (webapp.Client, error) { return mock, nil }
	t.Cleanup(func() {
		testClientFn = nil
		resetFlags(t)
		currentConfig = defaults.Config{Defaults: make(defaults.Values)}
		rootCmd.SilenceErrors = false
		rootCmd.SilenceUsage = false
	})

	rootCmd.SilenceErrors = true
	rootCmd.SilenceUsage = true
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)

	resetFlags(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}
	return
}

// resetFlags clears Changed state on rootCmd's persistent flags so tests don't
// bleed into each other.
func resetFlags(t *testing.T) {
	t.Helper()
	for _, name := range []string{"spreadsheet-id", "sheet-name"} {
		if f := rootCmd.PersistentFlags().Lookup(name); f != nil {
			_ = f.Value.Set("")
			f.Changed = false
		}
	}
}

func writeConfig(t *testing.T, home string, cfg defaults.Config) {
	t.Helper()
	dir := filepath.Join(home, ".config", "mpu")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "config.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func readConfig(t *testing.T, home string) defaults.Config {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".config", "mpu", "config.json"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg defaults.Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	return cfg
}

func run(args ...string) error {
	rootCmd.SetArgs(args)
	// Discard output for cleaner test logs.
	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	return rootCmd.Execute()
}

// ── tests ─────────────────────────────────────────────────────────────────────

// Explicit flag is used in the request and saved to defaults.
func TestExplicitFlagOverridesAndSaves(t *testing.T) {
	home, mock := setupTest(t)

	if err := run("webApp", "get", "-s", "explicit-id", "-n", "ExplicitSheet"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "explicit-id" {
		t.Errorf("ssId: got %v, want explicit-id", req["ssId"])
	}
	if req["sheetName"] != "ExplicitSheet" {
		t.Errorf("sheetName: got %v, want ExplicitSheet", req["sheetName"])
	}

	cfg := readConfig(t, home)
	if cfg.Defaults["spreadsheet-id"] != "explicit-id" {
		t.Errorf("saved spreadsheet-id: got %v", cfg.Defaults["spreadsheet-id"])
	}
	if cfg.Defaults["sheet-name"] != "ExplicitSheet" {
		t.Errorf("saved sheet-name: got %v", cfg.Defaults["sheet-name"])
	}
}

// When flags are omitted the values from defaults are used.
func TestMissingFlagFallsBackToDefaults(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "saved-id", "sheet-name": "SavedSheet"},
	})

	if err := run("webApp", "get"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "saved-id" {
		t.Errorf("ssId: got %v, want saved-id", req["ssId"])
	}
	if req["sheetName"] != "SavedSheet" {
		t.Errorf("sheetName: got %v, want SavedSheet", req["sheetName"])
	}
}

// When flag is omitted and not in defaults an error is returned.
func TestMissingFlagNoDefaultsErrors(t *testing.T) {
	setupTest(t)

	err := run("webApp", "get")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// Only the missing flag is taken from defaults; explicit flag wins over saved.
func TestExplicitFlagWinsOverSavedDefault(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "saved-id", "sheet-name": "SavedSheet"},
	})

	if err := run("webApp", "get", "-n", "OtherSheet"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	// -s not provided → falls back to default
	if req["ssId"] != "saved-id" {
		t.Errorf("ssId: got %v, want saved-id", req["ssId"])
	}
	// -n provided explicitly → overrides saved default
	if req["sheetName"] != "OtherSheet" {
		t.Errorf("sheetName: got %v, want OtherSheet", req["sheetName"])
	}

	// saved default for sheet-name is updated to the new explicit value
	cfg := readConfig(t, home)
	if cfg.Defaults["sheet-name"] != "OtherSheet" {
		t.Errorf("sheet-name not updated in defaults: got %v", cfg.Defaults["sheet-name"])
	}
}

// `mpu` with no args repeats the last command using all defaults.
func TestBareMpuRepeatsLastCommand(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "get",
		Defaults:  defaults.Values{"spreadsheet-id": "saved-id", "sheet-name": "SavedSheet"},
	})

	if err := run(); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["ssId"] != "saved-id" {
		t.Errorf("ssId: got %v, want saved-id", req["ssId"])
	}
	if req["sheetName"] != "SavedSheet" {
		t.Errorf("sheetName: got %v, want SavedSheet", req["sheetName"])
	}
}

// `mpu -n OtherSheet` uses the explicit flag, ignoring the saved default.
func TestBareMpuWithExplicitFlagOverridesDefault(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "get",
		Defaults:  defaults.Values{"spreadsheet-id": "saved-id", "sheet-name": "SavedSheet"},
	})

	if err := run("-n", "OtherSheet"); err != nil {
		t.Fatalf("run: %v", err)
	}

	req := mock.lastRequest()
	if req["sheetName"] != "OtherSheet" {
		t.Errorf("sheetName: got %v, want OtherSheet", req["sheetName"])
	}
	// -s not provided → still uses saved default
	if req["ssId"] != "saved-id" {
		t.Errorf("ssId: got %v, want saved-id", req["ssId"])
	}

	// saved default is updated
	cfg := readConfig(t, home)
	if cfg.Defaults["sheet-name"] != "OtherSheet" {
		t.Errorf("saved sheet-name: got %v, want OtherSheet", cfg.Defaults["sheet-name"])
	}
}

// `mpu` with no saved command returns no error (shows help).
func TestBareMpuNoSavedCommandShowsHelp(t *testing.T) {
	setupTest(t)
	// No config → empty command

	if err := run(); err != nil {
		t.Fatalf("expected no error from help, got: %v", err)
	}
}

// `mpu` when last command requires positional args returns a clean error.
func TestBareMpuCannotRepeatCommandWithArgs(t *testing.T) {
	home, _ := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "set",
		Defaults:  defaults.Values{"spreadsheet-id": "id", "sheet-name": "Sheet1"},
	})

	err := run()
	if err == nil {
		t.Fatal("expected error for set without args, got nil")
	}
}

// Shortcut `mpu get` saves "get" as the command in config.
func TestShortcutSavesCommandName(t *testing.T) {
	home, _ := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "id", "sheet-name": "Sheet1"},
	})

	if err := run("get"); err != nil {
		t.Fatalf("run: %v", err)
	}

	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Errorf("command: got %q, want %q", cfg.Command, "get")
	}
}

// `mpu webApp get` also saves "get" as the command.
func TestWebAppGetSavesCommandName(t *testing.T) {
	home, _ := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "id", "sheet-name": "Sheet1"},
	})

	if err := run("webApp", "get"); err != nil {
		t.Fatalf("run: %v", err)
	}

	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Errorf("command: got %q, want %q", cfg.Command, "get")
	}
}
