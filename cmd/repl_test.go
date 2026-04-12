package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"mpu/internal/defaults"
	"mpu/internal/janet"
)

// ── Existing tests (skipDefaults / script) ───────────────────────

// repl command does not overwrite the saved Command in config.json.
func TestReplDoesNotUpdateLastCommand(t *testing.T) {
	home, _ := setupTest(t)

	writeConfig(t, home, defaults.Config{
		Protected: false,
		Command:   "get",
		Defaults:  defaults.Values{"spreadsheet-id": "sid", "sheet-name": "Sheet1"},
	})

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

	if err := run("get"); err != nil {
		t.Fatalf("run get: %v", err)
	}
	cfg := readConfig(t, home)
	if cfg.Command != "get" {
		t.Fatalf("after get: Command=%q, want get", cfg.Command)
	}

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

// ── isBalanced tests ─────────────────────────────────────────────

func TestIsBalanced(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"", true},
		{"(+ 1 2)", true},
		{"(+ 1 2", false},
		{"(+ 1 2))", true}, // depth goes negative → still "balanced" (no continuation)
		{"((+ 1 2)", false},
		{`(string "hello")`, true},
		{`(string "he(lo")`, true},  // parens inside string
		{`(string "he\"lo")`, true}, // escaped quote
		{`(let [a 1] (+ a 2))`, true},
		{`(let [a 1] (+ a 2)`, false},
		{`(let [a 1`, false},
		{`[1 2 3]`, true},
		{`{:a 1 :b 2}`, true},
		{`{:a 1 :b`, false},
		{`(do (+ 1 2) (- 3 4))`, true},
		{`"unclosed string`, true}, // unbalanced string doesn't affect paren depth
	}
	for _, tc := range tests {
		got := isBalanced(tc.input)
		if got != tc.want {
			t.Errorf("isBalanced(%q) = %v, want %v", tc.input, got, tc.want)
		}
	}
}

// ── extractCurrentWord tests ─────────────────────────────────────

func TestExtractCurrentWord(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", ""},
		{"mpu/g", "mpu/g"},
		{"(mpu/g", "mpu/g"},
		{"(mpu/get ", ""},
		{"(mpu/get -", "-"},
		{"(mpu/get --she", "--she"},
		{"(mpu/get \"-s\" \"abc\" --f", "--f"},
		{"(let [x (mpu/cl", "mpu/cl"},
		{"hello", "hello"},
		{"(+ 1 ", ""},
		{"(mpu/get \"-s\" \"abc\")", ""},
		{"commands", "commands"},
		{"%ti", "%ti"},
	}
	for _, tc := range tests {
		got := extractCurrentWord(tc.input)
		if got != tc.want {
			t.Errorf("extractCurrentWord(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ── findEnclosingCommand tests ───────────────────────────────────

func TestFindEnclosingCommand(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", ""},
		{"(mpu/get --", "get"},
		{"(mpu/get \"-s\" \"X\" --she", "get"},
		{"(let [x (mpu/client --", "client"},
		{"(mpu/editors/get --", "editors/get"},
		{"no mpu here --", ""},
		{"mpu/ldb --", "ldb"},
		{"(mpu/rsdb \"--host\" \"sl-1\" --sche", "rsdb"},
	}
	for _, tc := range tests {
		got := findEnclosingCommand(tc.input)
		if got != tc.want {
			t.Errorf("findEnclosingCommand(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ── collectLeafCommands tests ────────────────────────────────────

func TestCollectLeafCommands(t *testing.T) {
	setupTest(t)

	cmds := collectLeafCommands()

	// Must have some commands.
	if len(cmds) == 0 {
		t.Fatal("collectLeafCommands returned empty map")
	}

	// Verify known commands exist.
	for _, name := range []string{"get", "set", "client", "clients", "token", "config-path"} {
		if _, ok := cmds[name]; !ok {
			t.Errorf("expected command %q in leaf commands", name)
		}
	}

	// Verify excluded commands are absent.
	for _, name := range []string{"help", "repl", "completion"} {
		if _, ok := cmds[name]; ok {
			t.Errorf("command %q should be excluded", name)
		}
	}

	// Verify nested commands have slash-separated names.
	found := false
	for name := range cmds {
		if strings.Contains(name, "/") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected at least one nested command (containing /)")
	}
}

// ── Completer tests (use doComplete directly, not channel-based Do) ──

// newCompleterState creates a replState usable for doComplete tests.
// Uses a real Janet VM so Janet-based completion works.
func newCompleterState(t *testing.T) *replState {
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
	return state
}

func TestCompleterMpuCommands(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	resp := state.doComplete(compRequest{line: "(mpu/ge", pos: 7})
	if resp.length != len("mpu/ge") {
		t.Errorf("length = %d, want %d", resp.length, len("mpu/ge"))
	}
	found := false
	for _, c := range resp.suffixes {
		if string(c) == "t" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected suffix 't' (for mpu/get) in completions")
	}
}

func TestCompleterMpuPrefix(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	resp := state.doComplete(compRequest{line: "(mp", pos: 3})
	if resp.length != len("mp") {
		t.Errorf("length = %d, want %d", resp.length, len("mp"))
	}
	if len(resp.suffixes) == 0 {
		t.Fatal("expected candidates for 'mp'")
	}
	for _, c := range resp.suffixes {
		s := string(c)
		if !strings.HasPrefix(s, "u/") {
			t.Errorf("suffix %q should start with 'u/'", s)
		}
	}
}

func TestCompleterFlags(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	resp := state.doComplete(compRequest{line: "(mpu/get --s", pos: 12})
	if resp.length != len("--s") {
		t.Errorf("length = %d, want %d", resp.length, len("--s"))
	}
	var suffixes []string
	for _, c := range resp.suffixes {
		suffixes = append(suffixes, string(c))
	}
	foundSS := false
	foundSN := false
	for _, s := range suffixes {
		if s == "preadsheet-id" {
			foundSS = true
		}
		if s == "heet-name" {
			foundSN = true
		}
	}
	if !foundSS {
		t.Errorf("expected suffix 'preadsheet-id', got %v", suffixes)
	}
	if !foundSN {
		t.Errorf("expected suffix 'heet-name', got %v", suffixes)
	}
}

func TestCompleterJanetSymbols(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	// "highlight/va" should match "highlight/value" via Janet symbols.
	resp := state.doComplete(compRequest{line: "(highlight/va", pos: 13})
	if len(resp.suffixes) == 0 {
		t.Fatal("expected candidates for 'highlight/va'")
	}
	found := false
	for _, c := range resp.suffixes {
		if string(c) == "lue" { // "highlight/value"[len("highlight/va"):] = "lue"
			found = true
			break
		}
	}
	if !found {
		var ss []string
		for _, c := range resp.suffixes {
			ss = append(ss, string(c))
		}
		t.Errorf("expected suffix 'lue' (for highlight/value), got %v", ss)
	}
}

func TestCompleterEmpty(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	resp := state.doComplete(compRequest{line: "", pos: 0})
	if len(resp.suffixes) != 0 {
		t.Errorf("expected no candidates for empty, got %d", len(resp.suffixes))
	}

	// Top-level whitespace outside any call: no completions.
	resp = state.doComplete(compRequest{line: "   ", pos: 3})
	if len(resp.suffixes) != 0 {
		t.Errorf("expected no candidates for top-level whitespace, got %d", len(resp.suffixes))
	}
}

func TestCompleterMpuKeywordFlagsEmpty(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	// After "(mpu/get " with empty word, Janet should return keyword flags.
	resp := state.doComplete(compRequest{line: "(mpu/get ", pos: 9})
	if resp.length != 0 {
		t.Errorf("length = %d, want 0 for empty word", resp.length)
	}
	if len(resp.suffixes) == 0 {
		t.Fatal("expected candidates after '(mpu/get '")
	}
	got := map[string]bool{}
	for _, s := range resp.suffixes {
		got[string(s)] = true
	}
	for _, want := range []string{":spreadsheet-id", ":sheet-name"} {
		if !got[want] {
			t.Errorf("missing keyword flag %q in %v", want, keysOf(got))
		}
	}
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestCompleterUserFunctionParams(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	if _, err := state.vm.DoString(`(defn foo [a bb ccc] :ok)`); err != nil {
		t.Fatalf("defn foo: %v", err)
	}

	// Empty word after "(foo " → all three params.
	resp := state.doComplete(compRequest{line: "(foo ", pos: 5})
	if len(resp.suffixes) == 0 {
		t.Fatal("expected param candidates for (foo ")
	}
	got := map[string]bool{}
	for _, s := range resp.suffixes {
		got[string(s)] = true
	}
	for _, want := range []string{"a", "bb", "ccc"} {
		if !got[want] {
			t.Errorf("missing param %q in %v", want, keysOf(got))
		}
	}
	if got["foo"] {
		t.Errorf("self-reference 'foo' should be filtered out")
	}

	// Prefix filter: "(foo bb" → only "bb".
	resp = state.doComplete(compRequest{line: "(foo bb", pos: 7})
	if resp.length != 2 {
		t.Errorf("length = %d, want 2", resp.length)
	}
	// Suffix after "bb" is "" (exact match).
	foundBB := false
	for _, s := range resp.suffixes {
		if "bb"+string(s) == "bb" {
			foundBB = true
		}
	}
	if !foundBB {
		var ss []string
		for _, s := range resp.suffixes {
			ss = append(ss, "bb"+string(s))
		}
		t.Errorf("expected 'bb' among candidates, got %v", ss)
	}
}

func TestCompleterEnclosingCallSkipsStrings(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	if _, err := state.vm.DoString(`(defn bar [xx yy] :ok)`); err != nil {
		t.Fatalf("defn bar: %v", err)
	}

	// A '(' inside a string literal must not confuse the parser.
	resp := state.doComplete(compRequest{line: `(bar "(" `, pos: 9})
	got := map[string]bool{}
	for _, s := range resp.suffixes {
		got[string(s)] = true
	}
	for _, want := range []string{"xx", "yy"} {
		if !got[want] {
			t.Errorf("missing param %q in %v (string paren confused parser?)",
				want, keysOf(got))
		}
	}
}

func TestCompleterUnterminatedString(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	// Must not hang or panic; deterministic empty result.
	resp := state.doComplete(compRequest{line: `(foo "abc `, pos: 10})
	if len(resp.suffixes) != 0 {
		t.Errorf("expected no candidates for unterminated string, got %d",
			len(resp.suffixes))
	}
}

func TestEnclosingCallParser(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	cases := []struct {
		line string
		want string // empty means nil
	}{
		{"(foo ", "foo"},
		{"(mpu/get ", "mpu/get"},
		{`(foo "(" `, "foo"},
		{"(foo (bar 1 2) ", "foo"},
		{"(foo (bar ", "bar"},
		{`(foo "abc `, ""}, // unterminated string
		{"", ""},
		{"top-level ", ""},
		{"(foo \n bar\n  ", "foo"},   // multi-line
		{`(foo "\\"`, "foo"},          // even backslashes: closing quote real
		{`(foo "a\"b" `, "foo"},       // escaped quote inside string
	}
	for _, tc := range cases {
		code := fmt.Sprintf(`(let [r (complete/enclosing-call %q)] (if r (get r :name) ""))`, tc.line)
		arr, err := state.vm.EvalStringSlice(fmt.Sprintf(`@[%s]`, code))
		if err != nil {
			t.Errorf("line %q: eval error: %v", tc.line, err)
			continue
		}
		got := ""
		if len(arr) > 0 {
			got = arr[0]
		}
		if got != tc.want {
			t.Errorf("line %q: got %q, want %q", tc.line, got, tc.want)
		}
	}
}

func TestCompleterSingleCandidate(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	resp := state.doComplete(compRequest{line: "(mpu/toke", pos: 9})
	if resp.length != len("mpu/toke") {
		t.Errorf("length = %d, want %d", resp.length, len("mpu/toke"))
	}
	if len(resp.suffixes) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(resp.suffixes))
	}
	if got := string(resp.suffixes[0]); got != "n" {
		t.Errorf("suffix = %q, want 'n'", got)
	}
}

// ── Janet script loading tests ───────────────────────────────────

func TestLoadJanetScripts(t *testing.T) {
	setupTest(t)

	// Create a temp dir with a minimal Janet script.
	jDir := t.TempDir()
	t.Setenv("MPU_JANET_DIR", jDir)

	// Write a highlight.janet that defines a test function.
	err := os.WriteFile(filepath.Join(jDir, "highlight.janet"),
		[]byte(`(defn test/loaded [] "yes")`), 0644)
	if err != nil {
		t.Fatal(err)
	}

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	loadJanetScripts(vm)

	result, err := vm.DoString(`(test/loaded)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "yes" {
		t.Errorf("got %q, want %q", result, "yes")
	}
}

func TestLoadJanetScriptsMissingDir(t *testing.T) {
	setupTest(t)

	// Point to a non-existent directory — should not panic.
	t.Setenv("MPU_JANET_DIR", "/nonexistent/path/to/janet")

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	// Should silently skip all files.
	loadJanetScripts(vm)

	// VM should still work.
	result, err := vm.DoString(`(+ 1 2)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "3" {
		t.Errorf("got %q, want %q", result, "3")
	}
}

func TestLoadJanetScriptsRcFile(t *testing.T) {
	setupTest(t)

	jDir := t.TempDir()
	t.Setenv("MPU_JANET_DIR", jDir)

	// Write rc.janet that defines a custom binding.
	err := os.WriteFile(filepath.Join(jDir, "rc.janet"),
		[]byte(`(defn my-custom-fn [] "custom")`), 0644)
	if err != nil {
		t.Fatal(err)
	}

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	loadJanetScripts(vm)

	result, err := vm.DoString(`(my-custom-fn)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "custom" {
		t.Errorf("got %q, want %q", result, "custom")
	}
}

// ── janetDir tests ───────────────────────────────────────────────

func TestJanetDir_Default(t *testing.T) {
	setupTest(t)

	home, _ := os.UserHomeDir()
	want := filepath.Join(home, ".config", "mpu", "janet")
	got := janetDir()
	if got != want {
		t.Errorf("janetDir() = %q, want %q", got, want)
	}
}

func TestJanetDir_EnvOverride(t *testing.T) {
	setupTest(t)

	t.Setenv("MPU_JANET_DIR", "/custom/janet/path")
	got := janetDir()
	if got != "/custom/janet/path" {
		t.Errorf("janetDir() = %q, want /custom/janet/path", got)
	}
}

// ── Bridge function tests ────────────────────────────────────────

func TestBridgeCommands(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	if err := registerAllCommands(vm); err != nil {
		t.Fatal(err)
	}

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     t.TempDir(),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	registerREPLBridge(vm, state)

	// repl/commands should return tab-separated lines.
	result, err := vm.DoString(`(repl/commands)`)
	if err != nil {
		t.Fatalf("repl/commands: %v", err)
	}
	if !strings.Contains(result, "get\t") {
		t.Errorf("repl/commands should contain 'get\\t...', got: %s", result[:min(len(result), 200)])
	}
	if !strings.Contains(result, "client\t") {
		t.Errorf("repl/commands should contain 'client\\t...', got: %s", result[:min(len(result), 200)])
	}
}

func TestBridgeFlags(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	if err := registerAllCommands(vm); err != nil {
		t.Fatal(err)
	}

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     t.TempDir(),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	registerREPLBridge(vm, state)

	// repl/flags for "get" should include --spreadsheet-id.
	result, err := vm.DoString(`(repl/flags "get")`)
	if err != nil {
		t.Fatalf("repl/flags: %v", err)
	}
	if !strings.Contains(result, "--spreadsheet-id") {
		t.Errorf("repl/flags for get should contain --spreadsheet-id, got: %s", result)
	}
	if !strings.Contains(result, "--sheet-name") {
		t.Errorf("repl/flags for get should contain --sheet-name, got: %s", result)
	}
}

func TestBridgeFlagsUnknown(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     t.TempDir(),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	registerREPLBridge(vm, state)

	// Unknown command should return empty.
	result, err := vm.DoString(`(repl/flags "nonexistent")`)
	if err != nil {
		t.Fatalf("repl/flags: %v", err)
	}
	if result != "" {
		t.Errorf("repl/flags for unknown command should be empty, got: %q", result)
	}
}

func TestBridgeDoc(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	if err := registerAllCommands(vm); err != nil {
		t.Fatal(err)
	}

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     t.TempDir(),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	registerREPLBridge(vm, state)

	// repl/doc for "get" should return non-empty text.
	result, err := vm.DoString(`(repl/doc "get")`)
	if err != nil {
		t.Fatalf("repl/doc: %v", err)
	}
	if result == "" {
		t.Error("repl/doc for 'get' should not be empty")
	}
}

func TestBridgeJanetDir(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	jDir := t.TempDir()
	state := &replState{
		vm:   vm,
		jDir: jDir,
	}
	registerREPLBridge(vm, state)

	result, err := vm.DoString(`(repl/janet-dir)`)
	if err != nil {
		t.Fatalf("repl/janet-dir: %v", err)
	}
	if result != jDir {
		t.Errorf("repl/janet-dir = %q, want %q", result, jDir)
	}
}

func TestBridgeHistoryFile(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	state := &replState{
		vm:       vm,
		histFile: "/tmp/test-history",
	}
	registerREPLBridge(vm, state)

	result, err := vm.DoString(`(repl/history-file)`)
	if err != nil {
		t.Fatalf("repl/history-file: %v", err)
	}
	if result != "/tmp/test-history" {
		t.Errorf("repl/history-file = %q, want /tmp/test-history", result)
	}
}

func TestBridgeHistory(t *testing.T) {
	setupTest(t)

	// Create a history file.
	histFile := filepath.Join(t.TempDir(), "history")
	lines := []string{"(+ 1 2)", "(mpu/get)", "(mpu/client \"42\")", "(commands)", "(? mpu/get)"}
	err := os.WriteFile(histFile, []byte(strings.Join(lines, "\n")+"\n"), 0644)
	if err != nil {
		t.Fatal(err)
	}

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	state := &replState{
		vm:       vm,
		histFile: histFile,
	}
	registerREPLBridge(vm, state)

	// Get last 3 entries.
	result, err := vm.DoString(`(repl/history "3")`)
	if err != nil {
		t.Fatalf("repl/history: %v", err)
	}
	resultLines := strings.Split(result, "\n")
	if len(resultLines) != 3 {
		t.Fatalf("expected 3 history lines, got %d: %v", len(resultLines), resultLines)
	}
	if resultLines[0] != `(mpu/client "42")` {
		t.Errorf("history[0] = %q, want (mpu/client \"42\")", resultLines[0])
	}
}

// ── Janet script content tests ───────────────────────────────────

// projectJanetDir returns the path to the janet/ directory in the source tree.
// It walks up from the test binary's working directory to find it.
func projectJanetDir(t *testing.T) string {
	t.Helper()
	// Tests run from cmd/, so ../janet/ is the project's janet dir.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	jDir := filepath.Join(dir, "..", "janet")
	if _, err := os.Stat(jDir); err != nil {
		t.Skipf("janet/ directory not found at %s, skipping", jDir)
	}
	return jDir
}

// Helper: create a VM with bridge + scripts loaded from the project's janet/ dir.
func newTestVM(t *testing.T) *janet.VM {
	t.Helper()

	jDir := projectJanetDir(t)
	t.Setenv("MPU_JANET_DIR", jDir)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}

	if err := registerAllCommands(vm); err != nil {
		vm.Close()
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
	registerREPLBridge(vm, state)
	loadJanetScripts(vm)

	return vm
}

func TestJanetHighlightValue(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	tests := []struct {
		input    string
		contains string // expected substring in output
	}{
		{`(highlight/value "42")`, "[34m42"}, // blue for numbers
		{`(highlight/value "\"hello\"")`, "[32m"},    // green for strings
		{`(highlight/value ":keyword")`, "[35m"},     // magenta for keywords
		{`(highlight/value "true")`, "[36m"},         // cyan for booleans
		{`(highlight/value "nil")`, "[90m"},          // gray for nil
		{`(highlight/value "@[1 2 3]")`, "[33m"},     // yellow for mutable
		{`(highlight/value "<function>")`, "[90m"},   // gray for abstractions
	}
	for _, tc := range tests {
		result, err := vm.DoString(tc.input)
		if err != nil {
			t.Errorf("DoString(%s): %v", tc.input, err)
			continue
		}
		if !strings.Contains(result, tc.contains) {
			t.Errorf("highlight/value %s = %q, want substring %q", tc.input, result, tc.contains)
		}
	}
}

func TestJanetHighlightResult(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	tests := []struct {
		input    string
		contains string
	}{
		{`(highlight/result 0 "42")`, "[34m"},   // number → blue
		{`(highlight/result 1 "nil")`, "[90m"},  // nil → gray
		{`(highlight/result 2 "true")`, "[36m"}, // boolean → cyan
		{`(highlight/result 4 "hi")`, "[32m"},   // string → green
		{`(highlight/result 6 "key")`, "[35m"},  // keyword → magenta
		{`(highlight/result 7 "@[1]")`, "[33m"}, // array → yellow
	}
	for _, tc := range tests {
		result, err := vm.DoString(tc.input)
		if err != nil {
			t.Errorf("DoString(%s): %v", tc.input, err)
			continue
		}
		if !strings.Contains(result, tc.contains) {
			t.Errorf("%s = %q, want substring %q", tc.input, result, tc.contains)
		}
	}
}

func TestJanetHighlightSource(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	// Should colorize keywords, strings, etc.
	result, err := vm.DoString(`(highlight/source "(defn foo [x] \"hello\")")`)
	if err != nil {
		t.Fatalf("highlight/source: %v", err)
	}
	// Should contain ANSI codes.
	if !strings.Contains(result, "\x1b[") {
		t.Errorf("highlight/source should contain ANSI codes, got: %q", result)
	}
	// Should contain "defn" (special form, bold+cyan).
	if !strings.Contains(result, "defn") {
		t.Errorf("highlight/source should contain 'defn', got: %q", result)
	}
}

func TestJanetPreludeVars(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	// _ starts as nil.
	result, err := vm.DoString(`(string _)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "" {
		t.Errorf("_ should be nil initially, got %q", result)
	}

	// *counter* starts at 0.
	result, err = vm.DoString(`(string *counter*)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "0" {
		t.Errorf("*counter* should be 0, got %q", result)
	}

	// Setting counter.
	vm.DoString(`(set *counter* 5)`)
	result, _ = vm.DoString(`(string *counter*)`)
	if result != "5" {
		t.Errorf("*counter* should be 5, got %q", result)
	}
}

func TestJanetPreludeResultHistory(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	// Simulate result updates like the REPL does.
	vm.DoString(`(set ___ __) (set __ _) (set _ 10)`)
	vm.DoString(`(set ___ __) (set __ _) (set _ 20)`)
	vm.DoString(`(set ___ __) (set __ _) (set _ 30)`)

	r, _ := vm.DoString(`(string _)`)
	if r != "30" {
		t.Errorf("_ = %q, want 30", r)
	}
	r, _ = vm.DoString(`(string __)`)
	if r != "20" {
		t.Errorf("__ = %q, want 20", r)
	}
	r, _ = vm.DoString(`(string ___)`)
	if r != "10" {
		t.Errorf("___ = %q, want 10", r)
	}
}

func TestJanetPreludeInputHistory(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	vm.DoString(`(set _iii _ii) (set _ii _i) (set _i "first")`)
	vm.DoString(`(set _iii _ii) (set _ii _i) (set _i "second")`)

	r, _ := vm.DoString(`_i`)
	if r != "second" {
		t.Errorf("_i = %q, want second", r)
	}
	r, _ = vm.DoString(`_ii`)
	if r != "first" {
		t.Errorf("_ii = %q, want first", r)
	}
}

func TestJanetPromptDefault(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	result, err := vm.DoString(`(prompt/get)`)
	if err != nil {
		t.Fatalf("prompt/get: %v", err)
	}
	// Should contain "mpu" and the counter.
	if !strings.Contains(result, "mpu") {
		t.Errorf("prompt should contain 'mpu', got %q", result)
	}
}

func TestJanetPromptCustom(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	vm.DoString(`(set-prompt (fn [] ">>> "))`)

	result, err := vm.DoString(`(prompt/get)`)
	if err != nil {
		t.Fatalf("prompt/get: %v", err)
	}
	if result != ">>> " {
		t.Errorf("custom prompt = %q, want '>>> '", result)
	}

	// Reset.
	vm.DoString(`(reset-prompt)`)
	result, _ = vm.DoString(`(prompt/get)`)
	if !strings.Contains(result, "mpu") {
		t.Errorf("after reset, prompt should contain 'mpu', got %q", result)
	}
}

func TestJanetPromptContinuation(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	result, err := vm.DoString(`(prompt/continuation)`)
	if err != nil {
		t.Fatalf("prompt/continuation: %v", err)
	}
	if !strings.Contains(result, "...") {
		t.Errorf("continuation prompt should contain '...', got %q", result)
	}
}

func TestJanetCompleteMpuNames(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	// Join the array to a string so we can check contents.
	result, err := vm.DoString(`(string/join (complete/mpu-names) "\n")`)
	if err != nil {
		t.Fatalf("complete/mpu-names: %v", err)
	}
	if !strings.Contains(result, "mpu/get") {
		t.Errorf("complete/mpu-names should contain mpu/get, got: %s", result[:min(len(result), 200)])
	}
}

func TestJanetCompleteFlagNames(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	// Join the array to a string so we can check contents.
	result, err := vm.DoString(`(string/join (complete/flag-names "get") "\n")`)
	if err != nil {
		t.Fatalf("complete/flag-names: %v", err)
	}
	if !strings.Contains(result, "--spreadsheet-id") {
		t.Errorf("complete/flag-names for 'get' should contain --spreadsheet-id, got: %s", result)
	}
}

func TestJanetColorFunctions(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	fns := []string{"color/red", "color/green", "color/blue", "color/yellow",
		"color/magenta", "color/cyan", "color/gray", "color/bold"}
	for _, fn := range fns {
		result, err := vm.DoString(`(` + fn + ` "test")`)
		if err != nil {
			t.Errorf("%s: %v", fn, err)
			continue
		}
		if !strings.Contains(result, "test") {
			t.Errorf("%s should contain 'test', got %q", fn, result)
		}
		if !strings.Contains(result, "\x1b[") {
			t.Errorf("%s should contain ANSI escape, got %q", fn, result)
		}
		if !strings.Contains(result, "\x1b[0m") {
			t.Errorf("%s should end with reset, got %q", fn, result)
		}
	}
}

func TestJanetHighlightToken(t *testing.T) {
	setupTest(t)

	vm := newTestVM(t)
	defer vm.Close()

	tests := []struct {
		token    string
		contains string
	}{
		{`"# comment"`, "[90m"},       // gray (comment)
		{`"\"string\""`, "[32m"},     // green (str)
		{`":key"`, "[35m"},            // magenta (kw)
		{`"true"`, "[36m"},            // cyan (bool)
		{`"42"`, "[34m"},              // blue (num)
		{`"def"`, "[1;36m"},           // bold cyan (special)
		{`"defn"`, "[1;33m"},          // bold yellow (macro)
		{`"mpu/get"`, "[38;5;214m"},   // orange (mpu)
		{`"foo"`, "foo"},              // unchanged
	}
	for _, tc := range tests {
		result, err := vm.DoString(`(highlight/token ` + tc.token + `)`)
		if err != nil {
			t.Errorf("highlight/token %s: %v", tc.token, err)
			continue
		}
		if !strings.Contains(result, tc.contains) {
			t.Errorf("highlight/token %s = %q, want substring %q", tc.token, result, tc.contains)
		}
	}
}

// ── Script mode with Janet modules loaded ────────────────────────

func TestReplScriptWithModules(t *testing.T) {
	home, _ := setupTest(t)
	t.Setenv("MPU_JANET_DIR", projectJanetDir(t))

	// Write a script that uses prelude functions.
	script := filepath.Join(home, "test.janet")
	code := `(if (nil? highlight/value) (error "modules not loaded") (+ 1 1))`
	if err := os.WriteFile(script, []byte(code), 0644); err != nil {
		t.Fatal(err)
	}

	if err := run("repl", script); err != nil {
		t.Fatalf("script with modules should work: %v", err)
	}
}

func TestReplScriptCanCallBridge(t *testing.T) {
	home, _ := setupTest(t)

	// Write a script that calls a bridge function.
	script := filepath.Join(home, "test.janet")
	code := `(def cmds (repl/commands)) (if (nil? cmds) (error "no commands") (+ 1 1))`
	if err := os.WriteFile(script, []byte(code), 0644); err != nil {
		t.Fatal(err)
	}

	if err := run("repl", script); err != nil {
		t.Fatalf("script calling bridge function should work: %v", err)
	}
}

// ── keywordsToCLI tests ──────────────────────────────────────────

func TestKeywordsToCLI(t *testing.T) {
	tests := []struct {
		input []string
		want  []string
	}{
		// keyword → long flag
		{[]string{":spreadsheet-id", "ABC"}, []string{"--spreadsheet-id", "ABC"}},
		// short keyword → short flag
		{[]string{":s", "ABC"}, []string{"-s", "ABC"}},
		// mixed: positional + keyword
		{[]string{"42", ":fields", "name,email"}, []string{"42", "--fields", "name,email"}},
		// pass through existing --flags
		{[]string{"--host", "sl-1"}, []string{"--host", "sl-1"}},
		// pass through existing -s flags
		{[]string{"-s", "ID"}, []string{"-s", "ID"}},
		// purely positional
		{[]string{"42", "SELECT 1"}, []string{"42", "SELECT 1"}},
		// empty
		{nil, []string{}},
		// multiple keywords
		{[]string{":s", "ID", ":n", "Sheet1"}, []string{"-s", "ID", "-n", "Sheet1"}},
	}
	for _, tc := range tests {
		got := keywordsToCLI(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("keywordsToCLI(%v) = %v, want %v", tc.input, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("keywordsToCLI(%v)[%d] = %q, want %q", tc.input, i, got[i], tc.want[i])
			}
		}
	}
}

// ── Keyword flag completion tests ────────────────────────────────

func TestCompleterKeywordFlags(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	// ":sheet" inside (mpu/get ...) should complete to ":sheet-name"
	resp := state.doComplete(compRequest{line: "(mpu/get :sheet", pos: 15})
	if len(resp.suffixes) == 0 {
		t.Fatal("expected keyword flag candidates for ':sheet'")
	}
	found := false
	for _, s := range resp.suffixes {
		if string(s) == "-name" { // ":sheet-name"[len(":sheet"):] = "-name"
			found = true
			break
		}
	}
	if !found {
		var ss []string
		for _, s := range resp.suffixes {
			ss = append(ss, string(s))
		}
		t.Errorf("expected suffix '-name' (for :sheet-name), got %v", ss)
	}
}

func TestCompleterKeywordSpreadsheet(t *testing.T) {
	setupTest(t)
	state := newCompleterState(t)

	// ":sp" inside (mpu/get ...) should complete to ":spreadsheet-id"
	resp := state.doComplete(compRequest{line: "(mpu/get :sp", pos: 12})
	if len(resp.suffixes) == 0 {
		t.Fatal("expected keyword flag candidates for ':sp'")
	}
	found := false
	for _, s := range resp.suffixes {
		if string(s) == "readsheet-id" {
			found = true
			break
		}
	}
	if !found {
		var ss []string
		for _, s := range resp.suffixes {
			ss = append(ss, string(s))
		}
		t.Errorf("expected suffix 'readsheet-id' (for :spreadsheet-id), got %v", ss)
	}
}

// ── Theme system tests ───────────────────────────────────────────

func TestJanetThemeDefault(t *testing.T) {
	setupTest(t)
	vm := newTestVM(t)
	defer vm.Close()

	// Default theme should have :num role.
	result, err := vm.DoString(`(get *theme* :num)`)
	if err != nil {
		t.Fatalf("get theme :num: %v", err)
	}
	if !strings.Contains(result, "[34m") {
		t.Errorf("default :num should be blue, got %q", result)
	}
}

func TestJanetThemeSwitch(t *testing.T) {
	setupTest(t)
	vm := newTestVM(t)
	defer vm.Close()

	// Switch to light theme, check color change.
	vm.DoString(`(set-theme theme/light)`)
	result, err := vm.DoString(`(get *theme* :special)`)
	if err != nil {
		t.Fatalf("get theme :special: %v", err)
	}
	if !strings.Contains(result, "[1;34m") {
		t.Errorf("light :special should be bold blue, got %q", result)
	}

	// Switch back.
	vm.DoString(`(set-theme theme/default)`)
	result, _ = vm.DoString(`(get *theme* :special)`)
	if !strings.Contains(result, "[1;36m") {
		t.Errorf("default :special should be bold cyan, got %q", result)
	}
}

func TestJanetPaintFunction(t *testing.T) {
	setupTest(t)
	vm := newTestVM(t)
	defer vm.Close()

	// paint should wrap text in theme color.
	result, err := vm.DoString(`(paint :num "42")`)
	if err != nil {
		t.Fatalf("paint: %v", err)
	}
	if !strings.Contains(result, "42") {
		t.Errorf("paint should contain text, got %q", result)
	}
	if !strings.Contains(result, "[34m") {
		t.Errorf("paint :num should use blue, got %q", result)
	}
	if !strings.Contains(result, "[0m") {
		t.Errorf("paint should end with reset, got %q", result)
	}
}

// ── Highlight specials vs macros ─────────────────────────────────

func TestJanetHighlightSpecialVsMacro(t *testing.T) {
	setupTest(t)
	vm := newTestVM(t)
	defer vm.Close()

	// "def" is a special form → bold cyan
	r1, _ := vm.DoString(`(highlight/token "def")`)
	if !strings.Contains(r1, "[1;36m") {
		t.Errorf("def should be special (bold cyan), got %q", r1)
	}

	// "defn" is a macro → bold yellow
	r2, _ := vm.DoString(`(highlight/token "defn")`)
	if !strings.Contains(r2, "[1;33m") {
		t.Errorf("defn should be macro (bold yellow), got %q", r2)
	}

	// They should be different colors.
	if r1 == r2 {
		t.Error("special form and macro should have different colors")
	}
}

func TestJanetHighlightDelimiters(t *testing.T) {
	setupTest(t)
	vm := newTestVM(t)
	defer vm.Close()

	// Source highlighting: parens should get :paren color.
	result, err := vm.DoString(`(highlight/source "(+ 1 2)")`)
	if err != nil {
		t.Fatalf("highlight/source: %v", err)
	}
	// Should contain gray parens (paren role = [90m)
	if !strings.Contains(result, "[90m") {
		t.Errorf("parens should be colored gray, got %q", result)
	}
}

// ── Completion context bridge test ───────────────────────────────

func TestBridgeCompletionContext(t *testing.T) {
	setupTest(t)

	vm, err := janet.New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
		jDir:     t.TempDir(),
		compCtx:  "get",
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	sort.Strings(state.cmdNames)
	registerREPLBridge(vm, state)

	result, err := vm.DoString(`(repl/completion-context)`)
	if err != nil {
		t.Fatalf("repl/completion-context: %v", err)
	}
	if result != "get" {
		t.Errorf("completion-context = %q, want 'get'", result)
	}
}

// ── Performance benchmarks for Janet scripts ─────────────────────
// Run: go test ./cmd/ -bench . -benchmem -timeout 120s

func newBenchVM(b *testing.B) *janet.VM {
	b.Helper()
	// Use project's janet dir.
	dir, _ := os.Getwd()
	jDir := filepath.Join(dir, "..", "janet")
	b.Setenv("MPU_JANET_DIR", jDir)

	vm, err := janet.New()
	if err != nil {
		b.Fatal(err)
	}
	_ = registerAllCommands(vm)
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

func BenchmarkJanetCompletion(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.EvalStringSlice(`(complete/candidates "(mpu/g" "mpu/g")`)
	}
}

func BenchmarkJanetHighlightValue(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(highlight/value "42")`)
	}
}

func BenchmarkJanetHighlightResult(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(highlight/result 0 "42")`)
	}
}

func BenchmarkJanetHighlightSource(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(highlight/source "(defn foo [x] (+ x 1))")`)
	}
}

func BenchmarkJanetPrompt(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(prompt/get)`)
	}
}

func BenchmarkGoFlagCompletion(b *testing.B) {
	vm := newBenchVM(b)
	defer vm.Close()

	state := &replState{
		vm:       vm,
		commands: collectLeafCommands(),
	}
	for name := range state.commands {
		state.cmdNames = append(state.cmdNames, name)
	}
	sort.Strings(state.cmdNames)

	b.ResetTimer()
	for b.Loop() {
		state.doComplete(compRequest{line: "(mpu/get :sh", pos: 12})
	}
}
