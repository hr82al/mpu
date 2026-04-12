package cmd

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// ── helpers ─────────────────────────────────────────────────────────────

// withCommandsDir seeds ~/.config/mpu/janet/commands/ with name→body entries,
// sets MPU_COMMANDS_DIR, returns the directory path.
func withCommandsDir(t *testing.T, files map[string]string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".config", "mpu", "janet", "commands")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		path := filepath.Join(dir, name+".janet")
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("MPU_COMMANDS_DIR", dir)
	return dir
}

// runMpu captures stdout/stderr while invoking rootCmd. Janet's (print ...)
// writes through the C FILE* for FD 1, so reassigning os.Stdout is not
// enough — we dup2 the pipe over FD 1/2 to redirect at the OS level.
func runMpu(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()

	outR, outW, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}
	errR, errW, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}

	origOutFd, _ := syscall.Dup(1)
	origErrFd, _ := syscall.Dup(2)
	_ = syscall.Dup2(int(outW.Fd()), 1)
	_ = syscall.Dup2(int(errW.Fd()), 2)

	// Collect in parallel so a full pipe buffer can't block writers.
	outCh := make(chan string, 1)
	errCh := make(chan string, 1)
	go func() { b, _ := io.ReadAll(outR); outCh <- string(b) }()
	go func() { b, _ := io.ReadAll(errR); errCh <- string(b) }()

	rootCmd.SetArgs(args)
	rootCmd.SetOut(outW)
	rootCmd.SetErr(errW)
	err = rootCmd.Execute()

	// Restore FDs before closing pipe ends so ReadAll sees EOF.
	_ = syscall.Dup2(origOutFd, 1)
	_ = syscall.Dup2(origErrFd, 2)
	syscall.Close(origOutFd)
	syscall.Close(origErrFd)
	outW.Close()
	errW.Close()

	return <-outCh, <-errCh, err
}

// ── discovery ───────────────────────────────────────────────────────────

// A .janet file in ~/.config/mpu/commands/ must show up as `mpu <name>`.
func TestJanetCommandDiscovered(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"hi": `(print "hello from janet")`,
	})
	// Force re-discovery because rootCmd is package-global.
	reloadJanetCommands()
	defer reloadJanetCommands() // restore after test

	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "hi" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected `mpu hi` to be discovered from commands dir")
	}
}

// Commands with dashes and digits work.
func TestJanetCommandNames(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"my-cmd":  `(print 1)`,
		"cmd2":    `(print 2)`,
		"a.b.c":   `(print 3)`, // dots in name should be fine
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	names := map[string]bool{}
	for _, c := range rootCmd.Commands() {
		names[c.Name()] = true
	}
	for _, want := range []string{"my-cmd", "cmd2", "a.b.c"} {
		if !names[want] {
			t.Errorf("missing discovered command %q", want)
		}
	}
}

// Non-.janet files are ignored.
func TestJanetCommandIgnoresNonJanet(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"ok": `(print "ok")`,
	})
	// Drop a junk file.
	dir := os.Getenv("MPU_COMMANDS_DIR")
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("#"), 0644)

	reloadJanetCommands()
	defer reloadJanetCommands()

	for _, c := range rootCmd.Commands() {
		if c.Name() == "README.md" || c.Name() == "README" {
			t.Error("README file should not become a command")
		}
	}
}

// The default path (without MPU_COMMANDS_DIR set) is
// $HOME/.config/mpu/janet/commands — nested under janet/ alongside the
// project scripts. Regression guard in case anyone "simplifies" it.
func TestCommandsDirDefaultPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("MPU_COMMANDS_DIR", "")

	got := commandsDir()
	want := filepath.Join(home, ".config", "mpu", "janet", "commands")
	if got != want {
		t.Errorf("commandsDir() = %q, want %q", got, want)
	}
}

// Missing commands dir is tolerated (no panic, no commands).
func TestJanetCommandNoDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("MPU_COMMANDS_DIR", filepath.Join(home, "does-not-exist"))

	reloadJanetCommands()
	defer reloadJanetCommands()

	// Just ensure nothing crashes.
}

// ── execution ───────────────────────────────────────────────────────────

// Running `mpu <cmd>` executes the script body.
func TestJanetCommandExecutes(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"stamp": `(print "STAMP-97531")`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	out, _, err := runMpu(t, "stamp")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(out, "STAMP-97531") {
		t.Errorf("expected stamp output, got %q", out)
	}
}

// Arguments after the command name are available in Janet as *args*
// (an array of strings).
func TestJanetCommandArgsAccessible(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"echo": `(each a *args* (print a))`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	out, _, err := runMpu(t, "echo", "alpha", "beta", "gamma")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	for _, want := range []string{"alpha", "beta", "gamma"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in output, got %q", want, out)
		}
	}
}

// Scripts can call registered mpu/* functions.
func TestJanetCommandCanCallMpu(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"greet": `(print (string "config-path=" (mpu/config-path)))`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	out, _, err := runMpu(t, "greet")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(out, "config-path=") {
		t.Errorf("expected config-path prefix, got %q", out)
	}
}

// ── errors ──────────────────────────────────────────────────────────────

// Script errors surface as Go errors when interactive-recovery is disabled,
// so tests and CI can distinguish failures. MPU_JANET_NO_RECOVER is the
// opt-out flag.
func TestJanetCommandErrorReturnedWithoutRecovery(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"break": `(error "intentional-test-error")`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	t.Setenv("MPU_JANET_NO_RECOVER", "1")
	_, _, err := runMpu(t, "break")
	if err == nil {
		t.Fatal("expected error from (error ...), got nil")
	}
	if !strings.Contains(err.Error(), "intentional-test-error") {
		t.Errorf("error should contain source message: %v", err)
	}
}

// mpu/* errors caught inside the script do NOT kill the script: Go errors
// propagate as Janet exceptions catchable by `try`.
func TestJanetCommandCatchesGoError(t *testing.T) {
	withCommandsDir(t, map[string]string{
		// Force an error by asking mpu/client without any credentials/cache.
		// We only need to verify that (try ...) can catch whatever it raises.
		"safe": `(def r (try (mpu/client "nonexistent-1234") ([e] (string "caught:" e))))
		         (print r)`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	t.Setenv("MPU_JANET_NO_RECOVER", "1")
	out, _, err := runMpu(t, "safe")
	if err != nil {
		t.Fatalf("run returned error even though script catches it: %v", err)
	}
	if !strings.Contains(out, "caught:") {
		t.Errorf("expected (try ...) branch to run, got %q", out)
	}
}

// Syntax errors also surface (not only runtime errors).
func TestJanetCommandSyntaxError(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"syntax": `(print "missing paren"`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	t.Setenv("MPU_JANET_NO_RECOVER", "1")
	_, _, err := runMpu(t, "syntax")
	if err == nil {
		t.Fatal("expected syntax error, got nil")
	}
}

// ── recovery hook ───────────────────────────────────────────────────────

// When recovery is enabled and a fake recovery handler is injected, it is
// invoked with the original error and the VM. This hooks without needing
// an interactive terminal in tests.
func TestJanetCommandRecoveryHookCalled(t *testing.T) {
	withCommandsDir(t, map[string]string{
		"fail": `(error "triggered")`,
	})
	reloadJanetCommands()
	defer reloadJanetCommands()

	// Install a hook that records the call, then suppresses the error.
	called := false
	gotMsg := ""
	origHook := recoveryHook
	recoveryHook = func(vm recoveryVM, scriptPath string, origErr error) error {
		called = true
		gotMsg = origErr.Error()
		return nil // act like "user fixed it and exited cleanly"
	}
	t.Cleanup(func() { recoveryHook = origHook })

	_, _, err := runMpu(t, "fail")
	if err != nil {
		t.Errorf("recovery hook suppressed error — got non-nil: %v", err)
	}
	if !called {
		t.Error("recovery hook was not invoked")
	}
	if !strings.Contains(gotMsg, "triggered") {
		t.Errorf("hook received wrong error: %q", gotMsg)
	}
}
