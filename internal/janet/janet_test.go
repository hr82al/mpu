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

	// The error is returned as a string value, not a Janet error.
	result, err := vm.DoString(`(test/fail)`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if !strings.Contains(result, "something went wrong") {
		t.Errorf("got %q, want error message", result)
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
