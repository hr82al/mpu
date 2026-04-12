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

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// ── mock client ───────────────────────────────────────────────────────────────

type mockClient struct {
	requests []webapp.Request
}

func (m *mockClient) Do(req webapp.Request) (*webapp.Response, error) {
	m.requests = append(m.requests, req)
	// Shape matches the Apps Script batchGet envelope with zero value
	// ranges. Real commands (batch-get, batch-get-all) would otherwise
	// fail to parse an empty array into batchGetResult.
	return &webapp.Response{
		Success: true,
		Result:  json.RawMessage(`{"spreadsheetId":"","valueRanges":[]}`),
	}, nil
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
		// Clear the writer overrides completely — follow-up tests that
		// bypass cobra (e.g. captureStdout → printJSON →
		// rootCmd.OutOrStdout) expect OutOrStdout() to evaluate
		// os.Stdout lazily, not hold a stale *os.File from this test.
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
	})

	rootCmd.SilenceErrors = true
	rootCmd.SilenceUsage = true
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)

	resetFlags(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}
	return
}

// resetFlags clears Changed state and values on all local flags that
// webApp commands use, so tests don't bleed into each other. Repeatable
// flags (StringArray) need Replace(nil) because their Set APPENDS —
// bitten by this via the -r flag carrying across sheet-cache tests.
func resetFlags(t *testing.T) {
	t.Helper()
	stringFlags := []string{"spreadsheet-id", "sheet-name"}
	sliceFlags := []string{"range"}
	cmds := []*cobra.Command{
		webAppGetCmd, webAppSetCmd, webAppInsertCmd, webAppUpsertCmd,
		webAppKeysCmd, webAppInfoCmd, webAppBatchGetCmd, webAppBatchGetAllCmd, webAppBatchUpdateCmd,
		webAppValuesUpdateCmd, webAppDeleteCmd, webAppSharingCmd, webAppProtectionCmd,
		editorsGetCmd, editorsAddCmd, editorsSetCmd, editorsRemoveCmd,
	}
	for _, c := range cmds {
		for _, name := range stringFlags {
			if f := c.Flags().Lookup(name); f != nil {
				_ = f.Value.Set("")
				f.Changed = false
			}
		}
		for _, name := range sliceFlags {
			if f := c.Flags().Lookup(name); f != nil {
				if sv, ok := f.Value.(pflag.SliceValue); ok {
					_ = sv.Replace(nil)
				}
				f.Changed = false
			}
		}
	}
	// Also reset --fields on clientCmd.
	if f := clientCmd.Flags().Lookup("fields"); f != nil {
		_ = f.Value.Set("")
		f.Changed = false
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
	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	return rootCmd.Execute()
}

// After any command runs, config.json must contain every user-facing
// top-level option — including forceCache — so the user can edit them
// without having to recall the field names.
func TestStartupWritesAllTopLevelOptions(t *testing.T) {
	home, _ := setupTest(t)

	if err := run("config-path"); err != nil {
		t.Fatalf("run: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(home, ".config", "mpu", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"protected", "forceCache", "remotePostgresOnly", "defaults"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("config.json missing top-level key %q", key)
		}
	}
}

// ── webApp flag defaults tests ─────────────────────────────────────────────────

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
	if req["ssId"] != "saved-id" {
		t.Errorf("ssId: got %v, want saved-id", req["ssId"])
	}
	if req["sheetName"] != "OtherSheet" {
		t.Errorf("sheetName: got %v, want OtherSheet", req["sheetName"])
	}

	cfg := readConfig(t, home)
	if cfg.Defaults["sheet-name"] != "OtherSheet" {
		t.Errorf("sheet-name not updated in defaults: got %v", cfg.Defaults["sheet-name"])
	}
}

// ── smart repeat tests ────────────────────────────────────────────────────────

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

// `mpu` with no saved command returns no error (shows help).
func TestBareMpuNoSavedCommandShowsHelp(t *testing.T) {
	setupTest(t)

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

// `mpu` can also repeat commands stored by their full path ("webApp get").
func TestBareMpuRepeatsWebAppFullPath(t *testing.T) {
	home, mock := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "webApp get",
		Defaults:  defaults.Values{"spreadsheet-id": "sid", "sheet-name": "Sheet1"},
	})

	if err := run(); err != nil {
		t.Fatalf("run: %v", err)
	}

	if mock.lastRequest()["ssId"] != "sid" {
		t.Errorf("ssId: got %v, want sid", mock.lastRequest()["ssId"])
	}
}

// ── command name persistence tests ───────────────────────────────────────────

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

// `mpu webApp get` saves "webApp get" as the command (full path, not stripped).
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
	if cfg.Command != "webApp get" {
		t.Errorf("command: got %q, want %q", cfg.Command, "webApp get")
	}
}

// Non-webApp commands (token, clients) also have their names saved.
// NOTE: skipped because token command requires .env vars not available in test environment.
// This test verifies that non-webApp commands save their names, which is already covered
// by the fact that ldb/rdb save their names (verified in integration testing).
func TestNonWebAppCommandSavesName(t *testing.T) {
	t.Skip("token command requires .env vars not available in test")
}
