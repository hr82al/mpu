package janet

import (
	"fmt"
	"strings"
	"testing"
)

func TestNewAndClose(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	vm.Close()
}

func TestDoString_Arithmetic(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.DoString("(+ 1 2)")
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "3" {
		t.Errorf("got %q, want %q", result, "3")
	}
}

func TestDoString_String(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.DoString(`"hello"`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "hello" {
		t.Errorf("got %q, want %q", result, "hello")
	}
}

func TestDoString_Error(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	_, err = vm.DoString("(error \"boom\")")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error %q should contain 'boom'", err.Error())
	}
}

func TestDoString_Nil(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.DoString("nil")
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	// janet_to_string on nil returns empty string.
	if result != "" {
		t.Errorf("got %q, want %q", result, "")
	}
}

func TestRegister_CallFromJanet(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	err = vm.Register("test", "greet", "say hello", func(args []string) (string, error) {
		if len(args) == 0 {
			return "hello", nil
		}
		return "hello " + args[0], nil
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	result, err := vm.DoString(`(test/greet "world")`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "hello world" {
		t.Errorf("got %q, want %q", result, "hello world")
	}
}

func TestRegister_NoArgs(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	err = vm.Register("test", "ping", "return pong", func(args []string) (string, error) {
		return "pong", nil
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	result, err := vm.DoString(`(test/ping)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "pong" {
		t.Errorf("got %q, want %q", result, "pong")
	}
}

func TestRegister_Error(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	err = vm.Register("test", "fail", "always fails", func(args []string) (string, error) {
		return "", fmt.Errorf("something went wrong")
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// An uncaught Go error raises a Janet panic, which DoString surfaces
	// as a Go error containing the message. (try ...) in Janet can catch
	// it — see errors_test.go:TestGoErrorPropagatesAsJanetException.
	_, err = vm.DoString(`(test/fail)`)
	if err == nil {
		t.Fatal("expected DoString error, got nil")
	}
	if !strings.Contains(err.Error(), "something went wrong") {
		t.Errorf("error should contain original message: %v", err)
	}
}

func TestRegister_MultipleArgs(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	err = vm.Register("test", "join", "join args", func(args []string) (string, error) {
		return strings.Join(args, "-"), nil
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	result, err := vm.DoString(`(test/join "a" "b" "c")`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "a-b-c" {
		t.Errorf("got %q, want %q", result, "a-b-c")
	}
}

func TestRegister_MultipleFunctions(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	for i := range 5 {
		n := fmt.Sprintf("fn%d", i)
		val := fmt.Sprintf("result-%d", i)
		err = vm.Register("test", n, n, func(args []string) (string, error) {
			return val, nil
		})
		if err != nil {
			t.Fatalf("Register %s: %v", n, err)
		}
	}

	for i := range 5 {
		result, err := vm.DoString(fmt.Sprintf(`(test/fn%d)`, i))
		if err != nil {
			t.Fatalf("DoString fn%d: %v", i, err)
		}
		want := fmt.Sprintf("result-%d", i)
		if result != want {
			t.Errorf("fn%d: got %q, want %q", i, result, want)
		}
	}
}

func TestDoString_JanetBuiltins(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	// Test that Janet stdlib works.
	result, err := vm.DoString(`(string/join ["a" "b" "c"] ",")`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if result != "a,b,c" {
		t.Errorf("got %q, want %q", result, "a,b,c")
	}
}

// ── DoEval tests ─────────────────────────────────────────────────

func TestDoEval_Number(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval("(+ 10 32)")
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeNumber {
		t.Errorf("type = %d, want TypeNumber (%d)", r.Type, TypeNumber)
	}
	if r.Num != 42 {
		t.Errorf("Num = %f, want 42", r.Num)
	}
	if r.Str != "42" {
		t.Errorf("Str = %q, want 42", r.Str)
	}
}

func TestDoEval_String(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(`"hello"`)
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeString {
		t.Errorf("type = %d, want TypeString (%d)", r.Type, TypeString)
	}
	if r.Str != "hello" {
		t.Errorf("Str = %q, want hello", r.Str)
	}
}

func TestDoEval_Boolean(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval("true")
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeBoolean {
		t.Errorf("type = %d, want TypeBoolean (%d)", r.Type, TypeBoolean)
	}
	if !r.Bool {
		t.Error("Bool = false, want true")
	}

	r, err = vm.DoEval("false")
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Bool {
		t.Error("Bool = true, want false")
	}
}

func TestDoEval_Nil(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval("nil")
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeNil {
		t.Errorf("type = %d, want TypeNil (%d)", r.Type, TypeNil)
	}
	if r.Str != "" {
		t.Errorf("Str = %q, want empty", r.Str)
	}
}

func TestDoEval_Keyword(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(":hello")
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeKeyword {
		t.Errorf("type = %d, want TypeKeyword (%d)", r.Type, TypeKeyword)
	}
	if r.Str != "hello" {
		t.Errorf("Str = %q, want hello", r.Str)
	}
}

func TestDoEval_Array(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(`@["a" "b" "c"]`)
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeArray {
		t.Errorf("type = %d, want TypeArray (%d)", r.Type, TypeArray)
	}
	if len(r.Arr) != 3 {
		t.Fatalf("Arr len = %d, want 3", len(r.Arr))
	}
	want := []string{"a", "b", "c"}
	for i, w := range want {
		if r.Arr[i] != w {
			t.Errorf("Arr[%d] = %q, want %q", i, r.Arr[i], w)
		}
	}
}

func TestDoEval_Tuple(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(`["x" "y"]`)
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeTuple {
		t.Errorf("type = %d, want TypeTuple (%d)", r.Type, TypeTuple)
	}
	if len(r.Arr) != 2 {
		t.Fatalf("Arr len = %d, want 2", len(r.Arr))
	}
	if r.Arr[0] != "x" || r.Arr[1] != "y" {
		t.Errorf("Arr = %v, want [x y]", r.Arr)
	}
}

func TestDoEval_Error(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	_, err = vm.DoEval(`(error "oops")`)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "oops") {
		t.Errorf("error %q should contain 'oops'", err.Error())
	}
}

func TestDoEval_MixedArray(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(`@[1 "two" :three true nil]`)
	if err != nil {
		t.Fatalf("DoEval: %v", err)
	}
	if r.Type != TypeArray {
		t.Fatalf("type = %d, want TypeArray", r.Type)
	}
	if len(r.Arr) != 5 {
		t.Fatalf("Arr len = %d, want 5", len(r.Arr))
	}
	// Elements are string representations.
	if r.Arr[0] != "1" {
		t.Errorf("Arr[0] = %q, want 1", r.Arr[0])
	}
	if r.Arr[1] != "two" {
		t.Errorf("Arr[1] = %q, want two", r.Arr[1])
	}
	if r.Arr[2] != "three" {
		t.Errorf("Arr[2] = %q, want three", r.Arr[2])
	}
}

// ── EvalStringSlice tests ────────────────────────────────────────

func TestEvalStringSlice_Array(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.EvalStringSlice(`@["hello" "world"]`)
	if err != nil {
		t.Fatalf("EvalStringSlice: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("len = %d, want 2", len(result))
	}
	if result[0] != "hello" || result[1] != "world" {
		t.Errorf("got %v, want [hello world]", result)
	}
}

func TestEvalStringSlice_Tuple(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.EvalStringSlice(`["a" "b" "c"]`)
	if err != nil {
		t.Fatalf("EvalStringSlice: %v", err)
	}
	if len(result) != 3 {
		t.Fatalf("len = %d, want 3", len(result))
	}
	if result[0] != "a" || result[1] != "b" || result[2] != "c" {
		t.Errorf("got %v, want [a b c]", result)
	}
}

func TestEvalStringSlice_Empty(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.EvalStringSlice(`@[]`)
	if err != nil {
		t.Fatalf("EvalStringSlice: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("len = %d, want 0", len(result))
	}
}

func TestEvalStringSlice_NonIndexed(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	// A string is not an indexed type — should return nil.
	result, err := vm.EvalStringSlice(`"hello"`)
	if err != nil {
		t.Fatalf("EvalStringSlice: %v", err)
	}
	if result != nil {
		t.Errorf("got %v, want nil", result)
	}
}

func TestEvalStringSlice_NumberElements(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	result, err := vm.EvalStringSlice(`@[1 2 3]`)
	if err != nil {
		t.Fatalf("EvalStringSlice: %v", err)
	}
	if len(result) != 3 {
		t.Fatalf("len = %d, want 3", len(result))
	}
	if result[0] != "1" || result[1] != "2" || result[2] != "3" {
		t.Errorf("got %v, want [1 2 3]", result)
	}
}

func TestEvalStringSlice_Error(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	_, err = vm.EvalStringSlice(`(error "fail")`)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ── Janet features enabled test ──────────────────────────────────

func TestJanet_OsClock(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	r, err := vm.DoEval(`(os/clock)`)
	if err != nil {
		t.Fatalf("os/clock: %v", err)
	}
	if r.Type != TypeNumber || r.Num <= 0 {
		t.Errorf("os/clock should return positive number, got type=%d num=%f", r.Type, r.Num)
	}
}

func TestJanet_Fiber(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	// Fiber/coroutine support.
	result, err := vm.DoString(`
		(def f (fiber/new (fn [] (yield 1) (yield 2) 3)))
		(string (resume f) "," (resume f) "," (resume f))
	`)
	if err != nil {
		t.Fatalf("fiber: %v", err)
	}
	if result != "1,2,3" {
		t.Errorf("fiber result = %q, want 1,2,3", result)
	}
}

func TestJanet_PEG(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer vm.Close()

	// PEG parsing.
	result, err := vm.EvalStringSlice(`(peg/match '(capture (some (range "az"))) "hello world")`)
	if err != nil {
		t.Fatalf("peg: %v", err)
	}
	if len(result) != 1 || result[0] != "hello" {
		t.Errorf("peg result = %v, want [hello]", result)
	}
}

// ── Benchmarks ───────────────────────────────────────────────────
// Run: go test ./internal/janet/ -bench . -benchmem

func BenchmarkDoString(b *testing.B) {
	vm, err := New()
	if err != nil {
		b.Fatal(err)
	}
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(+ 1 2)`)
	}
}

func BenchmarkDoEval(b *testing.B) {
	vm, err := New()
	if err != nil {
		b.Fatal(err)
	}
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.DoEval(`(+ 1 2)`)
	}
}

func BenchmarkEvalStringSlice(b *testing.B) {
	vm, err := New()
	if err != nil {
		b.Fatal(err)
	}
	defer vm.Close()

	b.ResetTimer()
	for b.Loop() {
		vm.EvalStringSlice(`@["a" "b" "c"]`)
	}
}

// BenchmarkJanetCode benchmarks arbitrary Janet code from an env var or hardcoded string.
// Useful for testing Janet script performance:
//
//	go test ./internal/janet/ -bench BenchmarkJanetCode -benchmem
func BenchmarkJanetCode(b *testing.B) {
	vm, err := New()
	if err != nil {
		b.Fatal(err)
	}
	defer vm.Close()

	// Default: a non-trivial Janet expression.
	code := `(do (def arr @[]) (for i 0 100 (array/push arr i)) (length arr))`

	b.ResetTimer()
	for b.Loop() {
		_, err := vm.DoString(code)
		if err != nil {
			b.Fatal(err)
		}
	}
}
