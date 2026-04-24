package janet

/*
#cgo CFLAGS: -std=c99 -DJANET_NO_DYNAMIC_MODULES -DJANET_NO_FFI
#cgo LDFLAGS: -lm

#include "janet.h"
#include <stdlib.h>
#include <string.h>

// Bridge called from Go-exported function below.
extern Janet janet_go_cfunc_bridge(int32_t argc, Janet *argv);

// Thread-local index set by each trampoline before calling the bridge.
static __thread int _current_trampoline_idx = -1;

static int get_current_trampoline_idx(void) {
	return _current_trampoline_idx;
}

// When a registered Go function returns an error we CANNOT call janet_panic
// from within the Go callback — it uses longjmp, which corrupts Go's stack.
// Instead Go stores the error message in a thread-local buffer and returns
// wrap_nil; the trampoline checks the buffer and calls janet_panic from C,
// so longjmp only unwinds the C stack up to the nearest janet_pcall frame.
static __thread int _panic_flag = 0;
static __thread char _panic_msg[1024];

static void set_go_panic(const char *msg) {
	size_t n = strlen(msg);
	if (n >= sizeof(_panic_msg)) n = sizeof(_panic_msg) - 1;
	memcpy(_panic_msg, msg, n);
	_panic_msg[n] = '\0';
	_panic_flag = 1;
}

// Each trampoline records its index, clears the panic flag, invokes the Go
// bridge, then raises a Janet panic if the Go side signalled one.
#define T(N) \
	static Janet _trampoline_##N(int32_t argc, Janet *argv) { \
		_current_trampoline_idx = N; \
		_panic_flag = 0; \
		Janet _r = janet_go_cfunc_bridge(argc, argv); \
		if (_panic_flag) { janet_panic(_panic_msg); } \
		return _r; \
	}

T(0)  T(1)  T(2)  T(3)  T(4)  T(5)  T(6)  T(7)
T(8)  T(9)  T(10) T(11) T(12) T(13) T(14) T(15)
T(16) T(17) T(18) T(19) T(20) T(21) T(22) T(23)
T(24) T(25) T(26) T(27) T(28) T(29) T(30) T(31)
T(32) T(33) T(34) T(35) T(36) T(37) T(38) T(39)
T(40) T(41) T(42) T(43) T(44) T(45) T(46) T(47)
T(48) T(49) T(50) T(51) T(52) T(53) T(54) T(55)
T(56) T(57) T(58) T(59) T(60) T(61) T(62) T(63)

#undef T

static JanetCFunction _trampolines[64] = {
	_trampoline_0,  _trampoline_1,  _trampoline_2,  _trampoline_3,
	_trampoline_4,  _trampoline_5,  _trampoline_6,  _trampoline_7,
	_trampoline_8,  _trampoline_9,  _trampoline_10, _trampoline_11,
	_trampoline_12, _trampoline_13, _trampoline_14, _trampoline_15,
	_trampoline_16, _trampoline_17, _trampoline_18, _trampoline_19,
	_trampoline_20, _trampoline_21, _trampoline_22, _trampoline_23,
	_trampoline_24, _trampoline_25, _trampoline_26, _trampoline_27,
	_trampoline_28, _trampoline_29, _trampoline_30, _trampoline_31,
	_trampoline_32, _trampoline_33, _trampoline_34, _trampoline_35,
	_trampoline_36, _trampoline_37, _trampoline_38, _trampoline_39,
	_trampoline_40, _trampoline_41, _trampoline_42, _trampoline_43,
	_trampoline_44, _trampoline_45, _trampoline_46, _trampoline_47,
	_trampoline_48, _trampoline_49, _trampoline_50, _trampoline_51,
	_trampoline_52, _trampoline_53, _trampoline_54, _trampoline_55,
	_trampoline_56, _trampoline_57, _trampoline_58, _trampoline_59,
	_trampoline_60, _trampoline_61, _trampoline_62, _trampoline_63,
};

static JanetCFunction get_trampoline(int idx) {
	if (idx < 0 || idx >= 64) return NULL;
	return _trampolines[idx];
}

// Register a single cfun into a Janet environment with a module prefix.
static void register_cfun(JanetTable *env, const char *prefix, const char *name,
                          JanetCFunction cfun, const char *doc) {
	JanetReg regs[2];
	regs[0].name = name;
	regs[0].cfun = cfun;
	regs[0].documentation = doc;
	regs[1].name = NULL;
	regs[1].cfun = NULL;
	regs[1].documentation = NULL;
	janet_cfuns_prefix(env, prefix, regs);
}

// ── Rich type helpers ────────────────────────────────────────────

static int janet_value_type(Janet x) {
	return (int)janet_type(x);
}

// Extract indexed sequence (array/tuple) as array of Janet string reprs.
// Returns count, fills buf with C strings (caller must free each).
static int janet_indexed_to_strings(Janet x, const char ***out) {
	const Janet *data;
	int32_t len;
	if (!janet_indexed_view(x, &data, &len)) {
		*out = NULL;
		return 0;
	}
	const char **buf = (const char **)malloc(sizeof(const char *) * len);
	if (!buf) { *out = NULL; return 0; }
	for (int32_t i = 0; i < len; i++) {
		const uint8_t *s = janet_to_string(data[i]);
		buf[i] = (const char *)s;
	}
	*out = buf;
	return (int)len;
}

// Get Janet value as double. Returns 0 if not a number.
static double janet_to_double(Janet x) {
	if (janet_checktype(x, JANET_NUMBER)) {
		return janet_unwrap_number(x);
	}
	return 0.0;
}

// Get Janet value as boolean.
static int janet_to_bool(Janet x) {
	if (janet_checktype(x, JANET_BOOLEAN)) {
		return janet_unwrap_boolean(x);
	}
	return janet_truthy(x);
}

// Report whether a Janet value is a keyword — callers prepend ':' on the
// Go side so keyword/string arguments stay distinguishable after janet_to_string.
static int janet_is_keyword(Janet x) {
	return janet_checktype(x, JANET_KEYWORD);
}

// Installs json/encode and json/decode (spork/json, vendored in json.c).
extern void spork_json_register(JanetTable *env);
*/
import "C"

import (
	"fmt"
	"runtime"
	"sync"
	"unsafe"
)

const maxFuncs = 64

// GoFunc is a function callable from Janet.
// Receives string arguments, returns a string result or error.
type GoFunc func(args []string) (string, error)

// Type represents a Janet value type.
type Type int

const (
	TypeNumber   Type = 0 // C.JANET_NUMBER
	TypeNil      Type = 1 // C.JANET_NIL
	TypeBoolean  Type = 2 // C.JANET_BOOLEAN
	TypeFiber    Type = 3
	TypeString   Type = 4
	TypeSymbol   Type = 5
	TypeKeyword  Type = 6
	TypeArray    Type = 7
	TypeTuple    Type = 8
	TypeTable    Type = 9
	TypeStruct   Type = 10
	TypeBuffer   Type = 11
	TypeFunction Type = 12
	TypeCFunction Type = 13
	TypeAbstract Type = 14
	TypePointer  Type = 15
)

// Result holds a typed Janet evaluation result.
type Result struct {
	Type   Type
	Str    string   // string representation (always set)
	Num    float64  // set for TypeNumber
	Bool   bool     // set for TypeBoolean
	Arr    []string // set for TypeArray/TypeTuple (string repr of each element)
}

// VM is an embedded Janet virtual machine.
type VM struct {
	env      *C.JanetTable
	mu       sync.Mutex
	funcs    [maxFuncs]GoFunc
	nextSlot int
}

var (
	globalVM *VM
	vmMu     sync.Mutex
)

//export janet_go_cfunc_bridge
func janet_go_cfunc_bridge(argc C.int32_t, argv *C.Janet) C.Janet {
	vmMu.Lock()
	vm := globalVM
	vmMu.Unlock()

	if vm == nil {
		return C.janet_wrap_nil()
	}

	idx := int(C.get_current_trampoline_idx())
	if idx < 0 || idx >= maxFuncs || vm.funcs[idx] == nil {
		return C.janet_wrap_nil()
	}

	// Convert Janet args to Go strings. janet_to_string strips the leading ':'
	// from keywords, so prepend it here to preserve the distinction between
	// keyword and string arguments on the Go side.
	n := int(argc)
	args := make([]string, n)
	for i := range n {
		arg := *(*C.Janet)(unsafe.Add(unsafe.Pointer(argv), uintptr(i)*unsafe.Sizeof(C.Janet{})))
		cstr := C.janet_to_string(arg)
		s := C.GoString((*C.char)(unsafe.Pointer(cstr)))
		if C.janet_is_keyword(arg) != 0 {
			s = ":" + s
		}
		args[i] = s
	}

	result, err := vm.funcs[idx](args)
	if err != nil {
		// Stash the message for the trampoline to turn into a Janet panic
		// AFTER the Go callback has fully unwound (longjmp across a cgo
		// boundary breaks Go's stack management).
		errStr := C.CString(err.Error())
		defer C.free(unsafe.Pointer(errStr))
		C.set_go_panic(errStr)
		return C.janet_wrap_nil()
	}

	if result == "" {
		return C.janet_wrap_nil()
	}
	cResult := C.CString(result)
	defer C.free(unsafe.Pointer(cResult))
	cjstr := C.janet_cstring(cResult)
	return C.janet_wrap_string(cjstr)
}

// New creates and initialises a Janet VM.
// It pins the calling goroutine to the current OS thread
// (runtime.LockOSThread) because Janet uses C thread-local storage.
// The caller MUST call Close() from the same goroutine to unlock the thread.
// All VM methods (DoString, Register) must also be called from this goroutine.
func New() (*VM, error) {
	runtime.LockOSThread()

	vmMu.Lock()
	defer vmMu.Unlock()

	C.janet_init()

	vm := &VM{env: C.janet_core_env(nil)}
	// Install vendored spork/json so json/encode and json/decode are always
	// available in the VM without requiring dynamic modules.
	C.spork_json_register(vm.env)
	globalVM = vm
	return vm, nil
}

// Close shuts down the Janet VM and unlocks the OS thread.
// Must be called from the same goroutine that called New().
func (vm *VM) Close() {
	vm.mu.Lock()
	defer vm.mu.Unlock()
	vmMu.Lock()
	if globalVM == vm {
		globalVM = nil
	}
	vmMu.Unlock()
	C.janet_deinit()
	runtime.UnlockOSThread()
}

// Register adds a Go function to the Janet environment as "prefix/name".
func (vm *VM) Register(prefix, name, doc string, fn GoFunc) error {
	vm.mu.Lock()
	defer vm.mu.Unlock()

	if vm.nextSlot >= maxFuncs {
		return fmt.Errorf("too many registered functions (max %d)", maxFuncs)
	}

	idx := vm.nextSlot
	vm.nextSlot++
	vm.funcs[idx] = fn

	cPrefix := C.CString(prefix)
	defer C.free(unsafe.Pointer(cPrefix))
	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	cDoc := C.CString(doc)
	defer C.free(unsafe.Pointer(cDoc))

	trampoline := C.get_trampoline(C.int(idx))
	if trampoline == nil {
		return fmt.Errorf("trampoline %d not available", idx)
	}

	C.register_cfun(vm.env, cPrefix, cName, trampoline, cDoc)
	return nil
}

// DoString executes a Janet expression and returns the string representation.
func (vm *VM) DoString(code string) (string, error) {
	vm.mu.Lock()
	defer vm.mu.Unlock()

	cCode := C.CString(code)
	defer C.free(unsafe.Pointer(cCode))
	cSource := C.CString("repl")
	defer C.free(unsafe.Pointer(cSource))

	var out C.Janet
	rc := C.janet_dostring(vm.env, cCode, cSource, &out)
	if rc != 0 {
		errStr := C.janet_to_string(out)
		return "", fmt.Errorf("%s", C.GoString((*C.char)(unsafe.Pointer(errStr))))
	}

	result := C.janet_to_string(out)
	return C.GoString((*C.char)(unsafe.Pointer(result))), nil
}

// DoEval executes Janet code and returns a typed Result.
func (vm *VM) DoEval(code string) (*Result, error) {
	vm.mu.Lock()
	defer vm.mu.Unlock()

	cCode := C.CString(code)
	defer C.free(unsafe.Pointer(cCode))
	cSource := C.CString("repl")
	defer C.free(unsafe.Pointer(cSource))

	var out C.Janet
	rc := C.janet_dostring(vm.env, cCode, cSource, &out)
	if rc != 0 {
		errStr := C.janet_to_string(out)
		return nil, fmt.Errorf("%s", C.GoString((*C.char)(unsafe.Pointer(errStr))))
	}

	return janetToResult(out), nil
}

// EvalStringSlice executes Janet code that must return an indexed sequence
// (array or tuple) and returns the elements as Go strings.
func (vm *VM) EvalStringSlice(code string) ([]string, error) {
	vm.mu.Lock()
	defer vm.mu.Unlock()

	cCode := C.CString(code)
	defer C.free(unsafe.Pointer(cCode))
	cSource := C.CString("repl")
	defer C.free(unsafe.Pointer(cSource))

	var out C.Janet
	rc := C.janet_dostring(vm.env, cCode, cSource, &out)
	if rc != 0 {
		errStr := C.janet_to_string(out)
		return nil, fmt.Errorf("%s", C.GoString((*C.char)(unsafe.Pointer(errStr))))
	}

	var cStrings **C.char
	n := C.janet_indexed_to_strings(out, (***C.char)(unsafe.Pointer(&cStrings)))
	if n == 0 || cStrings == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(cStrings))

	result := make([]string, int(n))
	for i := range int(n) {
		ptr := *(**C.char)(unsafe.Add(unsafe.Pointer(cStrings), uintptr(i)*unsafe.Sizeof(cStrings)))
		result[i] = C.GoString(ptr)
	}
	return result, nil
}

func janetToResult(val C.Janet) *Result {
	t := Type(C.janet_value_type(val))
	strRepr := C.janet_to_string(val)
	r := &Result{
		Type: t,
		Str:  C.GoString((*C.char)(unsafe.Pointer(strRepr))),
	}

	switch t {
	case TypeNumber:
		r.Num = float64(C.janet_to_double(val))
	case TypeBoolean:
		r.Bool = C.janet_to_bool(val) != 0
	case TypeNil:
		r.Str = ""
	case TypeArray, TypeTuple:
		var cStrings **C.char
		n := C.janet_indexed_to_strings(val, (***C.char)(unsafe.Pointer(&cStrings)))
		if n > 0 && cStrings != nil {
			r.Arr = make([]string, int(n))
			for i := range int(n) {
				ptr := *(**C.char)(unsafe.Add(unsafe.Pointer(cStrings), uintptr(i)*unsafe.Sizeof(cStrings)))
				r.Arr[i] = C.GoString(ptr)
			}
			C.free(unsafe.Pointer(cStrings))
		}
	}

	return r
}
