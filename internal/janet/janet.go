package janet

/*
#cgo CFLAGS: -std=c99 -DJANET_NO_DYNAMIC_MODULES -DJANET_NO_EV -DJANET_NO_NET -DJANET_NO_PROCESSES -DJANET_NO_FFI
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

// Each trampoline records its index, then calls into Go.
#define T(N) \
	static Janet _trampoline_##N(int32_t argc, Janet *argv) { \
		_current_trampoline_idx = N; \
		return janet_go_cfunc_bridge(argc, argv); \
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
*/
import "C"

import (
	"fmt"
	"sync"
	"unsafe"
)

const maxFuncs = 64

// GoFunc is a function callable from Janet.
// Receives string arguments, returns a string result or error.
type GoFunc func(args []string) (string, error)

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

	// Convert Janet args to Go strings.
	n := int(argc)
	args := make([]string, n)
	for i := range n {
		arg := *(*C.Janet)(unsafe.Add(unsafe.Pointer(argv), uintptr(i)*unsafe.Sizeof(C.Janet{})))
		cstr := C.janet_to_string(arg)
		args[i] = C.GoString((*C.char)(unsafe.Pointer(cstr)))
	}

	result, err := vm.funcs[idx](args)
	if err != nil {
		errStr := C.CString(err.Error())
		defer C.free(unsafe.Pointer(errStr))
		cjstr := C.janet_cstring(errStr)
		return C.janet_wrap_string(cjstr)
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
func New() (*VM, error) {
	vmMu.Lock()
	defer vmMu.Unlock()

	C.janet_init()

	vm := &VM{env: C.janet_core_env(nil)}
	globalVM = vm
	return vm, nil
}

// Close shuts down the Janet VM.
func (vm *VM) Close() {
	vm.mu.Lock()
	defer vm.mu.Unlock()
	vmMu.Lock()
	if globalVM == vm {
		globalVM = nil
	}
	vmMu.Unlock()
	C.janet_deinit()
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
