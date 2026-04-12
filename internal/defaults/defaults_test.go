package defaults_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"mpu/internal/defaults"
)

func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	return tmp
}

func TestLoadMissingFile(t *testing.T) {
	withTempHome(t)
	c, err := defaults.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.Protected {
		t.Errorf("expected Protected=true on missing file, got false")
	}
	if len(c.Defaults) != 0 {
		t.Errorf("expected empty Defaults, got %v", c.Defaults)
	}
}

func TestLoadInvalidJSON(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".config", "mpu")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{invalid json"), 0600); err != nil {
		t.Fatal(err)
	}

	c, err := defaults.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.Protected || len(c.Defaults) != 0 {
		t.Fatalf("expected Protected=true and empty Defaults on invalid JSON, got %+v", c)
	}
}

func TestSaveLoad(t *testing.T) {
	withTempHome(t)

	original := defaults.Config{
		Protected: false,
		Defaults: defaults.Values{
			"spreadsheet-id": "abc123",
			"sheet-name":     "MySheet",
			"header-row":     float64(2),
			"data-row":       float64(4),
		},
	}
	if err := defaults.Save(original); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := defaults.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if loaded.Protected != original.Protected {
		t.Errorf("Protected: got %v, want %v", loaded.Protected, original.Protected)
	}
	for k, want := range original.Defaults {
		got, ok := loaded.Defaults[k]
		if !ok {
			t.Errorf("key %q missing after Load", k)
			continue
		}
		if got != want {
			t.Errorf("key %q: got %v, want %v", k, got, want)
		}
	}
}

func TestSaveCreatesDirectory(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".config", "mpu")
	_ = os.RemoveAll(dir)

	if err := defaults.Save(defaults.Config{Defaults: defaults.Values{"spreadsheet-id": "x"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path := filepath.Join(dir, "config.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file at %s: %v", path, err)
	}
}

func TestSaveOverwritesExisting(t *testing.T) {
	withTempHome(t)

	save := func(sid string) {
		if err := defaults.Save(defaults.Config{Defaults: defaults.Values{"spreadsheet-id": sid}}); err != nil {
			t.Fatal(err)
		}
	}
	save("old")
	save("new")

	c, err := defaults.Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Defaults["spreadsheet-id"] != "new" {
		t.Errorf("expected 'new', got %v", c.Defaults["spreadsheet-id"])
	}
}

func TestSaveFilePermissions(t *testing.T) {
	home := withTempHome(t)
	if err := defaults.Save(defaults.Config{Defaults: defaults.Values{"k": "v"}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".config", "mpu", "config.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("expected file perm 0600, got %04o", perm)
	}
}

func TestProtectedDefaultsTrue(t *testing.T) {
	withTempHome(t)
	c, _ := defaults.Load()
	if !c.Protected {
		t.Error("expected Protected=true on new config")
	}
}

func TestProtectedRoundtrip(t *testing.T) {
	withTempHome(t)

	if err := defaults.Save(defaults.Config{Protected: true, Defaults: defaults.Values{}}); err != nil {
		t.Fatal(err)
	}
	c, err := defaults.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.Protected {
		t.Error("expected Protected=true after save/load")
	}
}

func TestProtectedNotOverwrittenBySave(t *testing.T) {
	withTempHome(t)

	// Write config.json with protected=true directly (simulates manual edit).
	home := os.Getenv("HOME")
	dir := filepath.Join(home, ".config", "mpu")
	_ = os.MkdirAll(dir, 0700)
	raw := `{"protected":true,"defaults":{"spreadsheet-id":"x"}}`
	_ = os.WriteFile(filepath.Join(dir, "config.json"), []byte(raw), 0600)

	// Load, modify defaults only, save back.
	c, _ := defaults.Load()
	c.Defaults["sheet-name"] = "Sheet1"
	if err := defaults.Save(c); err != nil {
		t.Fatal(err)
	}

	// Reload — protected must still be true.
	c2, _ := defaults.Load()
	if !c2.Protected {
		t.Error("Protected was reset to false after Save — should be preserved")
	}
	if c2.Defaults["sheet-name"] != "Sheet1" {
		t.Error("sheet-name not saved")
	}
}

// After Save, config.json must contain every user-facing top-level option
// (even at its zero value) so users can see and edit all knobs without
// recalling their names. forceCache in particular used to be omitempty.
func TestSaveWritesAllTopLevelOptions(t *testing.T) {
	home := withTempHome(t)
	if err := defaults.Save(defaults.Config{Defaults: defaults.Values{}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".config", "mpu", "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"protected", "forceCache", "remotePostgresOnly", "defaults"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("config.json missing top-level key %q", key)
		}
	}
}

func TestSaveFileIsValidJSON(t *testing.T) {
	home := withTempHome(t)
	if err := defaults.Save(defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "test", "header-row": float64(1)},
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".config", "mpu", "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("saved file is not valid JSON: %v\ncontent: %s", err, data)
	}
}
