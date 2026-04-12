package cmd

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"mpu/internal/janet"
)

// newHintVM builds a VM with Janet scripts loaded — hint.janet among them —
// so (hint/for ...) is callable. Uses the project's janet/ directory.
func newHintVM(t *testing.T) *janet.VM {
	t.Helper()
	jDir := projectJanetDir(t)
	t.Setenv("MPU_JANET_DIR", jDir)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { vm.Close() })

	if err := registerAllCommands(vm); err != nil {
		t.Fatal(err)
	}
	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     jDir,
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	sort.Strings(state.cmdNames)
	registerREPLBridge(vm, state)
	loadJanetScripts(vm)
	return vm
}

// ── hint/for ────────────────────────────────────────────────────────────

// Custom example registry: known mpu commands must return a descriptive
// multi-line hint with at least one example call.
func TestHintForMpuCommand(t *testing.T) {
	vm := newHintVM(t)

	out, err := vm.DoString(`(hint/for "mpu/get")`)
	if err != nil {
		t.Fatal(err)
	}
	if out == "" {
		t.Fatal(`hint/for "mpu/get" returned empty`)
	}
	if !strings.Contains(out, "mpu/get") {
		t.Errorf("hint should mention the command name: %q", out)
	}
}

// Standard Janet functions must fall back to their docstring.
func TestHintForJanetBuiltin(t *testing.T) {
	vm := newHintVM(t)

	out, err := vm.DoString(`(hint/for "map")`)
	if err != nil {
		t.Fatal(err)
	}
	if out == "" {
		t.Fatal(`hint/for "map" returned empty — should use docstring`)
	}
	// The docstring for map definitely mentions "function" or "each".
	lower := strings.ToLower(out)
	if !strings.Contains(lower, "function") && !strings.Contains(lower, "each") {
		t.Errorf("map hint seems wrong: %q", out)
	}
}

// Custom examples take precedence over docstrings.
func TestHintCustomOverrideWins(t *testing.T) {
	vm := newHintVM(t)

	// Register an override dynamically.
	if _, err := vm.DoString(`(hint/register "map" "CUSTOM MAP LINE" "(map inc [1 2 3])")`); err != nil {
		t.Fatal(err)
	}
	out, err := vm.DoString(`(hint/for "map")`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "CUSTOM MAP LINE") {
		t.Errorf("override not applied: %q", out)
	}
}

// Unknown symbols return an empty string (not an error).
func TestHintForUnknown(t *testing.T) {
	vm := newHintVM(t)

	out, err := vm.DoString(`(hint/for "zzz-does-not-exist")`)
	if err != nil {
		t.Fatalf("hint/for on unknown name should not error: %v", err)
	}
	if out != "" {
		t.Errorf("hint/for unknown: got %q, want empty", out)
	}
}

// Hints are capped at 10 lines.
func TestHintMaxLines(t *testing.T) {
	vm := newHintVM(t)

	// Register a very long override.
	lines := make([]string, 20)
	for i := range lines {
		lines[i] = `"line` + string(rune('A'+i)) + `"`
	}
	code := `(hint/register "big-fake" ` + strings.Join(lines, " ") + `)`
	if _, err := vm.DoString(code); err != nil {
		t.Fatal(err)
	}

	out, err := vm.DoString(`(hint/for "big-fake")`)
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	if out != "" {
		got = strings.Count(out, "\n") + 1
	}
	if got > 10 {
		t.Errorf("hint should be capped at 10 lines; got %d:\n%s", got, out)
	}
}

// Every mpu command must have some hint (custom example or Short from cobra).
func TestEveryMpuCommandHasHint(t *testing.T) {
	vm := newHintVM(t)

	cmds := collectLeafCommands()
	missing := []string{}
	for name := range cmds {
		code := `(hint/for "mpu/` + name + `")`
		out, err := vm.DoString(code)
		if err != nil {
			t.Errorf("hint/for mpu/%s errored: %v", name, err)
			continue
		}
		if out == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("mpu commands without any hint:\n  %s", strings.Join(missing, "\n  "))
	}
}

// Core Janet functions the user is likely to type should have hints.
// Missing ones are listed so we know what to add a custom example for.
func TestCoreJanetFunctionsHaveHint(t *testing.T) {
	vm := newHintVM(t)

	core := []string{
		"map", "filter", "reduce", "each", "get", "get-in", "put", "put-in",
		"update", "update-in", "keys", "values", "pairs", "length", "array?",
		"table?", "string?", "number?", "nil?", "json/encode", "json/decode",
	}
	missing := []string{}
	for _, name := range core {
		out, err := vm.DoString(`(hint/for "` + name + `")`)
		if err != nil {
			t.Errorf("hint/for %s errored: %v", name, err)
			continue
		}
		if out == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("core Janet functions without any hint:\n  %s", strings.Join(missing, "\n  "))
	}
}

// ── Go-side context detection ───────────────────────────────────────────

// detectHintContext must identify the function name the user is currently
// working with — either the enclosing call or the word being typed if it is
// the only remaining completion candidate.
func TestDetectHintContextEnclosingCall(t *testing.T) {
	tests := []struct {
		line string
		pos  int
		want string
	}{
		{"(mpu/get :s ", 12, "mpu/get"},
		{"(mpu/get :s \"ID\" ", 17, "mpu/get"},
		{"(map inc [1 2 ", 14, "map"},
		{"(filter odd? ", 13, "filter"},
	}
	for _, tc := range tests {
		got := detectHintContext(tc.line, tc.pos)
		if got != tc.want {
			t.Errorf("detectHintContext(%q, %d) = %q, want %q",
				tc.line, tc.pos, got, tc.want)
		}
	}
}

// When the cursor is on the function name itself (not after it), no hint.
func TestDetectHintContextTypingName(t *testing.T) {
	// Cursor is inside "mpu/ge" — the user is still picking a function.
	got := detectHintContext("(mpu/ge", 7)
	if got != "" {
		t.Errorf("should return empty while typing function name; got %q", got)
	}
}

// Empty input → no context.
func TestDetectHintContextEmpty(t *testing.T) {
	if got := detectHintContext("", 0); got != "" {
		t.Errorf("empty line: got %q, want empty", got)
	}
}

// When the typed prefix uniquely identifies a single mpu command,
// uniqueMpuMatch returns its fully-qualified name so the hint appears
// even before the user finishes typing.
func TestUniqueMpuMatch(t *testing.T) {
	cmds := []string{"get", "set", "batch-get", "batch-get-all", "keys", "token"}

	// "mpu/to" → only "token" matches.
	if got := uniqueMpuMatch([]rune("(mpu/to"), 7, cmds); got != "mpu/token" {
		t.Errorf(`mpu/to → %q, want mpu/token`, got)
	}
	// "mpu/set" → unique "set".
	if got := uniqueMpuMatch([]rune("(mpu/set"), 8, cmds); got != "mpu/set" {
		t.Errorf(`mpu/set → %q, want mpu/set`, got)
	}
	// "mpu/ba" → ambiguous (batch-get, batch-get-all).
	if got := uniqueMpuMatch([]rune("(mpu/ba"), 7, cmds); got != "" {
		t.Errorf(`mpu/ba ambiguous → %q, want empty`, got)
	}
	// Not an mpu/ prefix → empty.
	if got := uniqueMpuMatch([]rune("(ma"), 3, cmds); got != "" {
		t.Errorf(`ma (non-mpu) → %q, want empty`, got)
	}
	// Bare "mpu/" matches too many → empty.
	if got := uniqueMpuMatch([]rune("(mpu/"), 5, cmds); got != "" {
		t.Errorf(`mpu/ alone → %q, want empty`, got)
	}
	// Unknown prefix → empty.
	if got := uniqueMpuMatch([]rune("(mpu/xyz"), 8, cmds); got != "" {
		t.Errorf(`mpu/xyz → %q, want empty`, got)
	}
}

// ── Cache (goroutine-safety regression) ─────────────────────────────────

// buildHintCache must populate hints for every registered mpu command.
// This is the data structure that OnChange reads from readline's goroutine,
// so everything must be pre-computed by the time OnChange fires.
func TestBuildHintCacheCoversAllMpuCommands(t *testing.T) {
	vm := newHintVM(t)
	state := &replState{vm: vm, commands: collectLeafCommands()}
	for n := range state.commands {
		state.cmdNames = append(state.cmdNames, n)
	}
	sort.Strings(state.cmdNames)

	cache := buildHintCache(state)
	for _, name := range state.cmdNames {
		if cache["mpu/"+name] == "" {
			t.Errorf("cache missing mpu/%s", name)
		}
	}
}

// buildPrompt is on the readline goroutine's hot path — it must run purely
// off the precomputed cache, never touching the Janet VM. Regression: we
// null out state.vm so any stray vm.DoString would panic.
func TestBuildPromptDoesNotTouchJanet(t *testing.T) {
	vm := newHintVM(t)
	state := &replState{vm: vm, commands: collectLeafCommands(), counter: 5}
	for n := range state.commands {
		state.cmdNames = append(state.cmdNames, n)
	}
	sort.Strings(state.cmdNames)
	h := newHintRenderer(state)

	// From now on, VM is "off-limits" from this goroutine's perspective.
	state.vm = nil

	// mpu/get is in the cache — buildPrompt must return a framed hint.
	got := h.buildPrompt("mpu/get")
	if !strings.Contains(got, "mpu/get") {
		t.Errorf("buildPrompt(\"mpu/get\") missing hint content: %q", got)
	}
	// Unknown context → just the base prompt, no crash.
	got = h.buildPrompt("totally-unknown")
	if !strings.Contains(got, "mpu") {
		t.Errorf("base prompt missing: %q", got)
	}
	// Empty ctx → base prompt only.
	got = h.buildPrompt("")
	if strings.Contains(got, "hint") {
		t.Errorf("empty ctx should not emit hint frame: %q", got)
	}
}

// ── Benchmarks ──────────────────────────────────────────────────────────
// hint/for runs on every context change. Must stay well under 1ms so
// there's no perceptible typing lag.

func BenchmarkHintForMpuCommand(b *testing.B) {
	jDir := projectJanetDirB(b)
	b.Setenv("MPU_JANET_DIR", jDir)
	vm, err := janet.New()
	if err != nil {
		b.Fatal(err)
	}
	defer vm.Close()
	_ = registerAllCommands(vm)
	state := &replState{vm: vm, commands: collectLeafCommands(), jDir: jDir}
	for n := range state.commands {
		state.cmdNames = append(state.cmdNames, n)
	}
	sort.Strings(state.cmdNames)
	registerREPLBridge(vm, state)
	loadJanetScripts(vm)

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(hint/for "mpu/get")`)
	}
}

func BenchmarkDetectHintContext(b *testing.B) {
	line := "(mpu/get :s \"SHEET_ID\" :n \"Sheet1\" "
	pos := len(line)
	b.ResetTimer()
	for b.Loop() {
		detectHintContext(line, pos)
	}
}

// projectJanetDirB: benchmark variant of projectJanetDir.
func projectJanetDirB(b *testing.B) string {
	b.Helper()
	dir, _ := os.Getwd()
	return filepath.Join(dir, "..", "janet")
}
