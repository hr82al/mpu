package cmd

import (
	"bytes"
	"strings"
	"testing"

	"mpu/internal/defaults"

	"github.com/spf13/cobra"
)

// runConfig runs the config command with the given args and returns its stdout.
func runConfig(t *testing.T, args ...string) string {
	t.Helper()
	rootCmd.SetArgs(append([]string{"config"}, args...))
	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("config %v: %v", args, err)
	}
	return buf.String()
}

// No-args form lists every option, its description, and allowed values.
func TestConfigListsAllOptions(t *testing.T) {
	setupTest(t)

	out := runConfig(t)
	for _, opt := range configOptions {
		if !strings.Contains(out, opt.Name) {
			t.Errorf("listing missing option %q:\n%s", opt.Name, out)
		}
		if !strings.Contains(out, opt.Desc) {
			t.Errorf("listing missing description for %q:\n%s", opt.Name, out)
		}
	}
}

// Single-arg form shows the current value + allowed values for one option.
func TestConfigShowsSingleOption(t *testing.T) {
	setupTest(t)

	out := runConfig(t, "forceCache")
	if !strings.Contains(out, "forceCache") {
		t.Errorf("output missing option name:\n%s", out)
	}
	if !strings.Contains(out, "accumulate") || !strings.Contains(out, "use") {
		t.Errorf("output missing allowed values:\n%s", out)
	}
}

// Setting a valid value persists it to config.json and updates currentConfig.
func TestConfigSetPersistsValue(t *testing.T) {
	home, _ := setupTest(t)

	runConfig(t, "forceCache", "accumulate")

	if currentConfig.ForceCache != defaults.CacheModeAccumulate {
		t.Errorf("currentConfig.ForceCache = %q, want accumulate", currentConfig.ForceCache)
	}
	cfg := readConfig(t, home)
	if cfg.ForceCache != defaults.CacheModeAccumulate {
		t.Errorf("persisted forceCache = %q, want accumulate", cfg.ForceCache)
	}
}

// Boolean options accept true/false.
func TestConfigSetBool(t *testing.T) {
	home, _ := setupTest(t)

	runConfig(t, "protected", "false")
	if currentConfig.Protected {
		t.Error("protected should be false after set")
	}
	cfg := readConfig(t, home)
	if cfg.Protected {
		t.Error("persisted protected should be false")
	}
}

// Setting forceCache to empty string clears it.
func TestConfigSetEmptyClears(t *testing.T) {
	home, _ := setupTest(t)

	runConfig(t, "forceCache", "accumulate")
	runConfig(t, "forceCache", "")

	if currentConfig.ForceCache != defaults.CacheModeNone {
		t.Errorf("forceCache: got %q, want empty", currentConfig.ForceCache)
	}
	cfg := readConfig(t, home)
	if cfg.ForceCache != defaults.CacheModeNone {
		t.Errorf("persisted forceCache: got %q, want empty", cfg.ForceCache)
	}
}

// Unknown options yield a clear error.
func TestConfigUnknownOption(t *testing.T) {
	setupTest(t)

	rootCmd.SetArgs([]string{"config", "bogus"})
	rootCmd.SetOut(&bytes.Buffer{})
	err := rootCmd.Execute()
	if err == nil {
		t.Fatal("expected error for unknown option")
	}
	if !strings.Contains(err.Error(), "bogus") {
		t.Errorf("error should mention the option name: %v", err)
	}
}

// Invalid values for bool/enum options yield a clear error and do not touch state.
func TestConfigRejectsBadValue(t *testing.T) {
	setupTest(t)

	rootCmd.SetArgs([]string{"config", "forceCache", "nope"})
	rootCmd.SetOut(&bytes.Buffer{})
	err := rootCmd.Execute()
	if err == nil {
		t.Fatal("expected error for invalid forceCache value")
	}
	if currentConfig.ForceCache != defaults.CacheModeNone {
		t.Errorf("bad set must not mutate state; got %q", currentConfig.ForceCache)
	}
}

// Completion for the first arg returns every option name.
func TestConfigCompletesOptionNames(t *testing.T) {
	setupTest(t)

	suggestions, directive := configCmd.ValidArgsFunction(configCmd, nil, "")
	if directive != cobra.ShellCompDirectiveNoFileComp {
		t.Errorf("directive: got %v, want NoFileComp", directive)
	}
	for _, opt := range configOptions {
		found := false
		for _, s := range suggestions {
			if strings.HasPrefix(s, opt.Name+"\t") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("completion missing option %q; got %v", opt.Name, suggestions)
		}
	}
}

// Completion for the second arg returns allowed values for the chosen option.
func TestConfigCompletesValues(t *testing.T) {
	setupTest(t)

	suggestions, _ := configCmd.ValidArgsFunction(configCmd, []string{"forceCache"}, "")
	wantValues := []string{`""`, "accumulate", "use"}
	for _, want := range wantValues {
		found := false
		for _, s := range suggestions {
			if strings.HasPrefix(s, want+"\t") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing value suggestion %q; got %v", want, suggestions)
		}
	}
}

// Completion for a bool option offers true/false.
func TestConfigCompletesBoolValues(t *testing.T) {
	setupTest(t)

	suggestions, _ := configCmd.ValidArgsFunction(configCmd, []string{"protected"}, "")
	has := func(v string) bool {
		for _, s := range suggestions {
			if strings.HasPrefix(s, v+"\t") {
				return true
			}
		}
		return false
	}
	if !has("true") || !has("false") {
		t.Errorf("protected should complete true/false; got %v", suggestions)
	}
}

// Completion for an unknown option is empty (no file completion).
func TestConfigCompletionUnknownOption(t *testing.T) {
	setupTest(t)

	suggestions, directive := configCmd.ValidArgsFunction(configCmd, []string{"bogus"}, "")
	if len(suggestions) != 0 {
		t.Errorf("unknown option should have no suggestions; got %v", suggestions)
	}
	if directive != cobra.ShellCompDirectiveNoFileComp {
		t.Errorf("directive: got %v, want NoFileComp", directive)
	}
}

// Smart-repeat must not target `mpu config`; it's a meta command.
func TestConfigSkipsSmartRepeat(t *testing.T) {
	home, _ := setupTest(t)
	// Seed a prior command so we can verify it is preserved.
	writeConfig(t, home, defaults.Config{Command: "get", Defaults: defaults.Values{}})

	runConfig(t, "forceCache", "use")

	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Errorf("Command should be preserved; got %q, want %q", cfg.Command, "get")
	}
	if cfg.ForceCache != defaults.CacheModeUse {
		t.Errorf("forceCache should be persisted; got %q", cfg.ForceCache)
	}
}
