package cmd

import (
	"os"
	"testing"

	"mpu/internal/defaults"
)

// ── resolveDBArgs ─────────────────────────────────────────────────────────

func TestResolveDBArgs_TwoArgs_ParseID(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	id, sql, err := resolveDBArgs([]string{"42", "SELECT 1"})
	if err != nil {
		t.Fatalf("resolveDBArgs: %v", err)
	}
	if id != 42 {
		t.Errorf("id: got %d, want 42", id)
	}
	if sql != "SELECT 1" {
		t.Errorf("sql: got %q, want %q", sql, "SELECT 1")
	}

	// ID must be saved to defaults.
	v, ok := currentConfig.Defaults["client-id"]
	if !ok {
		t.Fatal("client-id not saved to defaults")
	}
	if v != float64(42) {
		t.Errorf("defaults[client-id]: got %v, want 42.0", v)
	}
}

func TestResolveDBArgs_OneArg_LoadIDFromDefaults(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: defaults.Values{"client-id": float64(99)}}

	id, sql, err := resolveDBArgs([]string{"SELECT 2"})
	if err != nil {
		t.Fatalf("resolveDBArgs: %v", err)
	}
	if id != 99 {
		t.Errorf("id: got %d, want 99", id)
	}
	if sql != "SELECT 2" {
		t.Errorf("sql: got %q, want %q", sql, "SELECT 2")
	}
}

func TestResolveDBArgs_OneArg_NoDefault_Error(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	_, _, err := resolveDBArgs([]string{"SELECT 1"})
	if err == nil {
		t.Fatal("expected error when no default, got nil")
	}
}

func TestResolveDBArgs_InvalidID_Error(t *testing.T) {
	setupTest(t)
	currentConfig = defaults.Config{Defaults: make(defaults.Values)}

	_, _, err := resolveDBArgs([]string{"notanumber", "SELECT 1"})
	if err == nil {
		t.Fatal("expected error for invalid id, got nil")
	}
}

// ── resolveRemoteHost ──────────────────────────────────────────────────────

func TestResolveRemoteHost_Underscore_Found(t *testing.T) {
	// Save original env
	orig := os.Getenv("sl_1")
	defer os.Setenv("sl_1", orig)

	os.Setenv("sl_1", "192.168.1.10")

	host, err := resolveRemoteHost("sl-1")
	if err != nil {
		t.Fatalf("resolveRemoteHost: %v", err)
	}
	if host != "192.168.1.10" {
		t.Errorf("got %q, want 192.168.1.10", host)
	}
}

func TestResolveRemoteHost_Uppercase_Found(t *testing.T) {
	orig := os.Getenv("TEST_SERVER_9")
	defer os.Setenv("TEST_SERVER_9", orig)

	os.Setenv("TEST_SERVER_9", "10.0.0.9")

	host, err := resolveRemoteHost("test-server-9")
	if err != nil {
		t.Fatalf("resolveRemoteHost: %v", err)
	}
	if host != "10.0.0.9" {
		t.Errorf("got %q, want 10.0.0.9", host)
	}
}

func TestResolveRemoteHost_NotFound_Error(t *testing.T) {
	// Ensure no such vars exist
	os.Unsetenv("nonexistent_server")
	os.Unsetenv("NONEXISTENT_SERVER")

	_, err := resolveRemoteHost("nonexistent-server")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestResolveRemoteHost_MultipleUnderscores(t *testing.T) {
	orig := os.Getenv("sl_multi_dash")
	defer os.Setenv("sl_multi_dash", orig)

	os.Setenv("sl_multi_dash", "10.0.0.99")

	host, err := resolveRemoteHost("sl-multi-dash")
	if err != nil {
		t.Fatalf("resolveRemoteHost: %v", err)
	}
	if host != "10.0.0.99" {
		t.Errorf("got %q, want 10.0.0.99", host)
	}
}
