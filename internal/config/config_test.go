package config_test

import (
	"testing"

	"mpu/internal/config"
)

// TestLoadPG_WithRealEnv tests LoadPG with actual .env values from ~/.config/mpu/.env.
// This test verifies that LoadPG can read the configured environment variables.
func TestLoadPG_WithRealEnv(t *testing.T) {
	cfg, err := config.LoadPG()
	if err != nil {
		// OK to fail if .env is not properly configured in test environment.
		// This is an integration test that requires real config.
		t.Skipf("LoadPG: %v (skipped - requires proper .env setup)", err)
	}

	if cfg.DBName == "" {
		t.Error("DBName is empty")
	}
	if cfg.ClientPassword == "" {
		t.Error("ClientPassword is empty")
	}
	if cfg.LocalPort == "" {
		t.Error("LocalPort is empty")
	}
	if cfg.RemotePort == "" {
		t.Error("RemotePort is empty")
	}
	if cfg.Host == "" {
		t.Error("Host is empty")
	}
}
