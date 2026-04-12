package janet

import (
	"fmt"
	"strings"
	"testing"
)

// Current behaviour (strings-as-errors) prevents idiomatic (try ...) in
// Janet. Registered Go functions returning an error should instead raise a
// Janet panic that (try body ([e] ...)) can catch. The error message must
// survive the trip.
func TestGoErrorPropagatesAsJanetException(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	err = vm.Register("boom", "fail", "always fails", func(args []string) (string, error) {
		return "", fmt.Errorf("something went wrong")
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	// (try (boom/fail) ([e] (string e))) — expect the error message back.
	got, err := vm.DoString(`(try (boom/fail) ([e] (string e)))`)
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if !strings.Contains(got, "something went wrong") {
		t.Errorf("caught exception should contain error message; got %q", got)
	}
}

// The direct call (without try) must propagate the error up to Go so
// vm.DoString returns a non-nil error containing the message.
func TestGoErrorSurfacesToCaller(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	vm.Register("boom", "fail2", "", func(args []string) (string, error) {
		return "", fmt.Errorf("kaboom-marker")
	})

	_, err = vm.DoString(`(boom/fail2)`)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "kaboom-marker") {
		t.Errorf("error should contain original message: %v", err)
	}
}

// Successful Go calls still return their string result (no regression).
func TestGoSuccessStillReturnsString(t *testing.T) {
	vm, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()

	vm.Register("ok", "hi", "", func(args []string) (string, error) {
		return "hello", nil
	})

	got, err := vm.DoString(`(ok/hi)`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello" {
		t.Errorf("got %q, want hello", got)
	}
}
