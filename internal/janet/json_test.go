package janet

import (
	"strings"
	"testing"
)

// Helpers ────────────────────────────────────────────────────────────────

func newJSONVM(t testing.TB) *VM {
	t.Helper()
	vm, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { vm.Close() })
	return vm
}

func jsonEval(t *testing.T, vm *VM, code string) string {
	t.Helper()
	out, err := vm.DoString(code)
	if err != nil {
		t.Fatalf("eval %q: %v", code, err)
	}
	return out
}

// ── Decode: primitives ──────────────────────────────────────────────────

// By default, JSON null decodes to the keyword :null — this preserves the
// distinction between "absent" (nil) and "explicit null" in round-trips.
// Passing nils=true swaps in Janet nil instead.
func TestJSONDecodeNull(t *testing.T) {
	vm := newJSONVM(t)
	// Default → :null
	got := jsonEval(t, vm, `(= :null (json/decode "null"))`)
	if got != "true" {
		t.Errorf("null default: got %q, want true", got)
	}
	// With nils=true → nil.
	got = jsonEval(t, vm, `(= nil (json/decode "null" nil true))`)
	if got != "true" {
		t.Errorf("null with nils=true: got %q, want true", got)
	}
}

func TestJSONDecodeBool(t *testing.T) {
	vm := newJSONVM(t)
	if got := jsonEval(t, vm, `(json/decode "true")`); got != "true" {
		t.Errorf("true: got %q, want true", got)
	}
	if got := jsonEval(t, vm, `(json/decode "false")`); got != "false" {
		t.Errorf("false: got %q, want false", got)
	}
}

func TestJSONDecodeNumber(t *testing.T) {
	vm := newJSONVM(t)
	tests := map[string]string{
		`(json/decode "0")`:          "0",
		`(json/decode "42")`:         "42",
		`(json/decode "-17")`:        "-17",
		`(json/decode "3.14")`:       "3.14",
		`(json/decode "1e3")`:        "1000",
		`(json/decode "-1.5e-2")`:    "-0.015",
	}
	for code, want := range tests {
		if got := jsonEval(t, vm, code); got != want {
			t.Errorf("%s: got %q, want %q", code, got, want)
		}
	}
}

func TestJSONDecodeString(t *testing.T) {
	vm := newJSONVM(t)
	if got := jsonEval(t, vm, `(json/decode "\"hello\"")`); got != "hello" {
		t.Errorf("string: got %q, want %q", got, "hello")
	}
	if got := jsonEval(t, vm, `(json/decode "\"\"")`); got != "" {
		t.Errorf("empty string: got %q, want empty", got)
	}
}

func TestJSONDecodeStringEscapes(t *testing.T) {
	vm := newJSONVM(t)
	// Input JSON contains: "line1\nline2\ttab\""
	got := jsonEval(t, vm, `(json/decode "\"line1\\nline2\\ttab\\\"\"")`)
	want := "line1\nline2\ttab\""
	if got != want {
		t.Errorf("escapes: got %q, want %q", got, want)
	}
}

func TestJSONDecodeStringUnicode(t *testing.T) {
	vm := newJSONVM(t)
	// JSON \u00e9 → é (U+00E9)
	got := jsonEval(t, vm, `(json/decode "\"caf\\u00e9\"")`)
	if got != "café" {
		t.Errorf("unicode: got %q, want %q", got, "café")
	}
	// Raw UTF-8 passes through untouched.
	got = jsonEval(t, vm, `(json/decode "\"привет\"")`)
	if got != "привет" {
		t.Errorf("utf-8: got %q, want %q", got, "привет")
	}
}

// ── Decode: composites ──────────────────────────────────────────────────

func TestJSONDecodeEmptyArray(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(length (json/decode "[]"))`)
	if got != "0" {
		t.Errorf("empty array: length %q, want 0", got)
	}
	// Result must be an array (mutable), not a tuple.
	got = jsonEval(t, vm, `(array? (json/decode "[]"))`)
	if got != "true" {
		t.Errorf("empty array: (array? ...) = %q, want true", got)
	}
}

func TestJSONDecodeArray(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(let [v (json/decode "[1,2,3]")] (+ (v 0) (v 1) (v 2)))`)
	if got != "6" {
		t.Errorf("sum [1,2,3]: got %q, want 6", got)
	}
}

func TestJSONDecodeArrayMixed(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(let [v (json/decode "[1,\"a\",true,null]")] (length v))`)
	if got != "4" {
		t.Errorf("mixed array length: got %q, want 4", got)
	}
}

func TestJSONDecodeEmptyObject(t *testing.T) {
	vm := newJSONVM(t)
	// Empty object → Janet table.
	got := jsonEval(t, vm, `(table? (json/decode "{}"))`)
	if got != "true" {
		t.Errorf("empty object: (table? ...) = %q, want true", got)
	}
	got = jsonEval(t, vm, `(length (json/decode "{}"))`)
	if got != "0" {
		t.Errorf("empty object length: got %q, want 0", got)
	}
}

func TestJSONDecodeObject(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(get (json/decode "{\"name\":\"ada\",\"age\":36}") "name")`)
	if got != "ada" {
		t.Errorf(`get "name": got %q, want "ada"`, got)
	}
	got = jsonEval(t, vm, `(get (json/decode "{\"name\":\"ada\",\"age\":36}") "age")`)
	if got != "36" {
		t.Errorf(`get "age": got %q, want 36`, got)
	}
}

func TestJSONDecodeObjectKeywords(t *testing.T) {
	vm := newJSONVM(t)
	// Second argument truthy → object keys become Janet keywords.
	got := jsonEval(t, vm, `(get (json/decode "{\"name\":\"ada\"}" true) :name)`)
	if got != "ada" {
		t.Errorf(`keyword-keys: got %q, want "ada"`, got)
	}
}

func TestJSONDecodeNested(t *testing.T) {
	vm := newJSONVM(t)
	src := `{"users":[{"id":1,"name":"ada"},{"id":2,"name":"turing"}]}`
	code := `(get-in (json/decode ` + quoteJSON(src) + `) ["users" 1 "name"])`
	if got := jsonEval(t, vm, code); got != "turing" {
		t.Errorf("nested get-in: got %q, want %q", got, "turing")
	}
}

// ── Decode: errors ──────────────────────────────────────────────────────

func TestJSONDecodeInvalid(t *testing.T) {
	vm := newJSONVM(t)
	cases := []string{
		`(json/decode "{")`,
		`(json/decode "[1,2,")`,
		`(json/decode "not json")`,
		`(json/decode "")`,
	}
	for _, code := range cases {
		if _, err := vm.DoString(code); err == nil {
			t.Errorf("expected error for %s", code)
		}
	}
}

// ── Encode: primitives ──────────────────────────────────────────────────

func TestJSONEncodePrimitives(t *testing.T) {
	vm := newJSONVM(t)
	tests := map[string]string{
		`(json/encode nil)`:      "null",
		`(json/encode true)`:     "true",
		`(json/encode false)`:    "false",
		`(json/encode 42)`:       "42",
		`(json/encode -1.5)`:     "-1.5",
		`(json/encode "hello")`:  `"hello"`,
		`(json/encode "")`:       `""`,
	}
	for code, want := range tests {
		if got := jsonEval(t, vm, code); got != want {
			t.Errorf("%s: got %q, want %q", code, got, want)
		}
	}
}

// spork encodes control characters as \uXXXX (always-safe RFC 8259 form)
// and doubles quotes. Round-trip is what matters — decode must reproduce
// the original bytes byte-for-byte.
func TestJSONEncodeStringEscape(t *testing.T) {
	vm := newJSONVM(t)
	// Encoded form contains \u000A for newline and \" for the quote.
	got := jsonEval(t, vm, `(json/encode "a\nb\"c")`)
	if !strings.Contains(got, `\u000A`) {
		t.Errorf("newline should be \\u000A-escaped; got %q", got)
	}
	if !strings.Contains(got, `\"`) {
		t.Errorf("quote should be \\\"-escaped; got %q", got)
	}
	// Round-trip must be exact.
	rt := jsonEval(t, vm, `(json/decode (json/encode "a\nb\"c"))`)
	if rt != "a\nb\"c" {
		t.Errorf("round-trip: got %q, want %q", rt, "a\nb\"c")
	}
}

func TestJSONEncodeKeyword(t *testing.T) {
	vm := newJSONVM(t)
	// Janet keyword encodes as its string form (no leading colon).
	got := jsonEval(t, vm, `(json/encode :hello)`)
	if got != `"hello"` {
		t.Errorf("keyword: got %q, want %q", got, `"hello"`)
	}
}

// ── Encode: composites ──────────────────────────────────────────────────

func TestJSONEncodeArray(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(json/encode [1 2 3])`)
	if got != "[1,2,3]" {
		t.Errorf("tuple: got %q, want [1,2,3]", got)
	}
	got = jsonEval(t, vm, `(json/encode @[1 2 3])`)
	if got != "[1,2,3]" {
		t.Errorf("array: got %q, want [1,2,3]", got)
	}
}

func TestJSONEncodeObject(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(json/encode @{"a" 1})`)
	if got != `{"a":1}` {
		t.Errorf("table: got %q, want {\"a\":1}", got)
	}
	// Struct also supported.
	got = jsonEval(t, vm, `(json/encode {"a" 1})`)
	if got != `{"a":1}` {
		t.Errorf("struct: got %q, want {\"a\":1}", got)
	}
}

func TestJSONEncodeKeywordKeys(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(json/encode @{:name "ada"})`)
	if got != `{"name":"ada"}` {
		t.Errorf("keyword key: got %q, want {\"name\":\"ada\"}", got)
	}
}

func TestJSONEncodeNested(t *testing.T) {
	vm := newJSONVM(t)
	got := jsonEval(t, vm, `(json/encode @{:users [@{:id 1 :name "ada"}]})`)
	want := `{"users":[{"id":1,"name":"ada"}]}`
	if got != want {
		t.Errorf("nested: got %q, want %q", got, want)
	}
}

// ── Encode: pretty-print ────────────────────────────────────────────────

func TestJSONEncodeIndent(t *testing.T) {
	vm := newJSONVM(t)
	// Pretty-printing with tab="  " indents each level.
	got := jsonEval(t, vm, `(json/encode @[1 2 3] "  ")`)
	// Accept either "\n" or system newline; just check indentation is present.
	if !strings.Contains(got, "\n  1") {
		t.Errorf("indent missing:\n%s", got)
	}
}

// ── Round-trip ──────────────────────────────────────────────────────────

func TestJSONRoundTrip(t *testing.T) {
	vm := newJSONVM(t)
	code := `(json/encode (json/decode "[1,2,3]"))`
	if got := jsonEval(t, vm, code); got != "[1,2,3]" {
		t.Errorf("array round-trip: got %q", got)
	}
	code = `(json/encode (json/decode "{\"a\":1,\"b\":2}"))`
	out := jsonEval(t, vm, code)
	// Table ordering isn't guaranteed — check the string contains both pairs.
	if !strings.Contains(out, `"a":1`) || !strings.Contains(out, `"b":2`) {
		t.Errorf("object round-trip missing keys: %q", out)
	}
}

// ── Lisp-way functional patterns ────────────────────────────────────────

// Decoded value + core get-in composes naturally.
func TestJSONPipelineGetIn(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(-> "{\"users\":[{\"name\":\"ada\"}]}"
		    json/decode
		    (get-in ["users" 0 "name"]))`
	if got := jsonEval(t, vm, code); got != "ada" {
		t.Errorf("-> get-in: got %q", got)
	}
}

// Map over a decoded JSON array with a Janet function.
func TestJSONMapOverArray(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(->> "[1,2,3,4]"
		     json/decode
		     (map |(* $ $))
		     json/encode)`
	if got := jsonEval(t, vm, code); got != "[1,4,9,16]" {
		t.Errorf("map squares: got %q, want [1,4,9,16]", got)
	}
}

// Filter elements of a decoded array of objects.
func TestJSONFilterObjects(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(->> "[{\"n\":1},{\"n\":2},{\"n\":3}]"
		     json/decode
		     (filter |(> ($ "n") 1))
		     length)`
	if got := jsonEval(t, vm, code); got != "2" {
		t.Errorf("filter n>1: got %q, want 2", got)
	}
}

// postwalk rewrites every value in a decoded tree.
func TestJSONPostwalkTransform(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(->> "{\"a\":[1,2,3]}"
		     json/decode
		     (postwalk |(if (number? $) (inc $) $))
		     json/encode)`
	out := jsonEval(t, vm, code)
	if !strings.Contains(out, "[2,3,4]") {
		t.Errorf("postwalk inc: got %q", out)
	}
}

// Functional update-in: change one leaf, re-encode.
func TestJSONUpdateIn(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(let [obj (json/decode "{\"user\":{\"name\":\"ada\"}}")]
		  (put-in obj ["user" "name"] "turing")
		  (json/encode obj))`
	out := jsonEval(t, vm, code)
	if !strings.Contains(out, `"name":"turing"`) {
		t.Errorf("put-in: got %q", out)
	}
}

// select-keys equivalent via table comprehension.
func TestJSONSelectKeys(t *testing.T) {
	vm := newJSONVM(t)
	code := `
		(let [obj (json/decode "{\"a\":1,\"b\":2,\"c\":3}")
		      subset (from-pairs (seq [k :in ["a" "c"]] [k (get obj k)]))]
		  (json/encode subset))`
	out := jsonEval(t, vm, code)
	if !strings.Contains(out, `"a":1`) || !strings.Contains(out, `"c":3`) {
		t.Errorf("select-keys: got %q", out)
	}
	if strings.Contains(out, `"b":2`) {
		t.Errorf("select-keys should drop 'b': %q", out)
	}
}

// ── quote helper ────────────────────────────────────────────────────────

// quoteJSON returns a Janet string literal that, when evaluated, produces src.
// We use backtick-quoted long strings to avoid double-escaping hell.
func quoteJSON(src string) string {
	return "`" + src + "`"
}

// ── Benchmarks ──────────────────────────────────────────────────────────
// Run: go test ./internal/janet -bench BenchmarkJSON -benchmem -timeout 60s

func BenchmarkJSONDecodeSmall(b *testing.B) {
	vm := newJSONVM(b)
	code := `(json/decode ` + "`" + `{"id":42,"name":"ada","active":true}` + "`" + `)`
	b.ResetTimer()
	for b.Loop() {
		vm.DoString(code)
	}
}

func BenchmarkJSONEncodeSmall(b *testing.B) {
	vm := newJSONVM(b)
	vm.DoString(`(def obj @{:id 42 :name "ada" :active true})`)
	b.ResetTimer()
	for b.Loop() {
		vm.DoString(`(json/encode obj)`)
	}
}

func BenchmarkJSONRoundTripMedium(b *testing.B) {
	vm := newJSONVM(b)
	// ~400 chars of typical API response.
	src := `{"users":[` +
		`{"id":1,"name":"ada","score":99.5},` +
		`{"id":2,"name":"turing","score":100},` +
		`{"id":3,"name":"hopper","score":87.2}],` +
		`"total":3,"active":true}`
	code := "(json/encode (json/decode `" + src + "`))"
	b.ResetTimer()
	for b.Loop() {
		vm.DoString(code)
	}
}
