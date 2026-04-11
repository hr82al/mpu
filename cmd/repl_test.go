package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"mpu/internal/defaults"
)

// repl command does not overwrite the saved Command in config.json.
func TestReplDoesNotUpdateLastCommand(t *testing.T) {
	home, _ := setupTest(t)

	// Pre-set a command so we can verify it survives the repl run.
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "get",
		Defaults:  defaults.Values{"spreadsheet-id": "sid", "sheet-name": "Sheet1"},
	})

	// Write a trivial Janet script for repl to execute.
	script := filepath.Join(home, "test.janet")
	if err := os.WriteFile(script, []byte(`(+ 1 2)`), 0644); err != nil {
		t.Fatal(err)
	}

	if err := run("repl", script); err != nil {
		t.Fatalf("run repl: %v", err)
	}

	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Errorf("Command: got %q, want %q (repl should not change it)", cfg.Command, "get")
	}
}

// repl command with no saved command should leave Command empty.
func TestReplPreservesEmptyCommand(t *testing.T) {
	home, _ := setupTest(t)

	script := filepath.Join(home, "test.janet")
	if err := os.WriteFile(script, []byte(`(+ 1 1)`), 0644); err != nil {
		t.Fatal(err)
	}

	if err := run("repl", script); err != nil {
		t.Fatalf("run repl: %v", err)
	}

	cfg := readConfig(t, home)
	if cfg.Command != "" {
		t.Errorf("Command: got %q, want empty", cfg.Command)
	}
}

// repl script can use Janet built-in functions.
func TestReplScriptExecution(t *testing.T) {
	home, _ := setupTest(t)

	script := filepath.Join(home, "test.janet")
	if err := os.WriteFile(script, []byte(`(string/join ["hello" "world"] " ")`), 0644); err != nil {
		t.Fatal(err)
	}

	if err := run("repl", script); err != nil {
		t.Fatalf("run repl: %v", err)
	}
}

// repl script with syntax error returns an error.
func TestReplScriptError(t *testing.T) {
	home, _ := setupTest(t)

	script := filepath.Join(home, "bad.janet")
	if err := os.WriteFile(script, []byte(`(error "test error")`), 0644); err != nil {
		t.Fatal(err)
	}

	err := run("repl", script)
	if err == nil {
		t.Fatal("expected error from bad script, got nil")
	}
}

// repl with missing script file returns an error.
func TestReplMissingScript(t *testing.T) {
	setupTest(t)

	err := run("repl", "/nonexistent/script.janet")
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

// After running some other command, then repl, the saved Command is preserved.
func TestReplAfterOtherCommandPreservesIt(t *testing.T) {
	home, _ := setupTest(t)
	writeConfig(t, home, defaults.Config{
		Protected: false,
		Defaults:  defaults.Values{"spreadsheet-id": "sid", "sheet-name": "Sheet1"},
	})

	// Run get first — should save "get" as command.
	if err := run("get"); err != nil {
		t.Fatalf("run get: %v", err)
	}
	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Fatalf("after get: Command=%q, want get", cfg.Command)
	}

	// Now run repl — should preserve "get".
	script := filepath.Join(home, "test.janet")
	if err := os.WriteFile(script, []byte(`(+ 1 1)`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := run("repl", script); err != nil {
		t.Fatalf("run repl: %v", err)
	}

	cfg = readConfig(t, home)
	if cfg.Command != "get" {
		t.Errorf("after repl: Command=%q, want get (should be preserved)", cfg.Command)
	}
}
