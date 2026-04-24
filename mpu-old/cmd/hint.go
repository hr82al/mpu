package cmd

import (
	"fmt"
	"strings"

	"github.com/chzyer/readline"
)

// hintRenderer updates the readline prompt with an inline hint block
// whenever the "hint context" (the function the user is working with)
// changes. The hint is shown above the input line as a multi-line prompt
// prefix; when the user presses Enter, the whole block is committed to
// scrollback — acceptable UX for a hint-as-you-type workflow that needs
// to work with chzyer/readline (no native footer support).
//
// IMPORTANT: OnChange fires on readline's goroutine, NOT the main goroutine
// that owns the Janet VM. Calling vm.DoString from here would crash because
// Janet uses C thread-local storage tied to the goroutine that called
// runtime.LockOSThread. So we precompute every known hint up front on the
// main goroutine and store the results in a plain string→string cache;
// OnChange does only map lookups + ANSI formatting, zero cgo.

type hintRenderer struct {
	state *replState
	cache map[string]string // name → rendered hint text (empty = no hint)
	last  string
}

func newHintRenderer(s *replState) *hintRenderer {
	return &hintRenderer{
		state: s,
		cache: buildHintCache(s),
	}
}

// buildHintCache asks Janet for a hint for every name the REPL might show
// one for — mpu commands plus the curated core-Janet set. Runs once, on
// the main goroutine, immediately after Janet scripts are loaded.
func buildHintCache(s *replState) map[string]string {
	cache := make(map[string]string, len(s.cmdNames)+64)

	// mpu/<name> for every registered command.
	for _, name := range s.cmdNames {
		cache["mpu/"+name] = lookupHint(s, "mpu/"+name)
	}

	// Core Janet + project functions that have curated examples.
	extras := []string{
		"map", "filter", "reduce", "reduce2", "each", "loop", "seq",
		"get", "get-in", "put", "put-in", "update", "update-in",
		"keys", "values", "pairs", "length",
		"array?", "tuple?", "table?", "struct?", "string?", "number?", "nil?",
		"string/split", "string/join", "string/format",
		"postwalk", "prewalk", "freeze", "thaw", "from-pairs",
		"inc", "dec", "sort", "sort-by", "take", "drop",
		"json/decode", "json/encode",
		"?", "commands", "apropos",
		"%time", "%who", "%hist", "%load", "%env", "%pp", "%highlight", "%reset",
		"set-theme",
	}
	for _, name := range extras {
		cache[name] = lookupHint(s, name)
	}
	return cache
}

// lookupHint evaluates (hint/for name) once and returns the formatted block.
// Empty result → empty string (never stores a nil entry).
func lookupHint(s *replState, name string) string {
	if s.vm == nil {
		return ""
	}
	raw, err := s.vm.DoString(fmt.Sprintf(`(hint/for %q)`, name))
	if err != nil || raw == "" {
		return ""
	}
	return formatHintBlock(raw)
}

// OnChange is invoked by readline on EVERY keystroke from readline's own
// goroutine. Therefore it must NEVER call into Janet (different goroutine
// than runtime.LockOSThread pinned) or do any expensive work. Everything
// here is pure Go + map lookup.
func (h *hintRenderer) OnChange(line []rune, pos int, key rune) ([]rune, int, bool) {
	if h.state == nil || h.state.rl == nil {
		return nil, 0, false
	}
	ctx := detectHintContext(string(line), pos)
	// Fallback: if there's no enclosing call, see if the word being typed
	// uniquely identifies an mpu command — if so, show that command's hint
	// even before the user finishes typing its name.
	if ctx == "" {
		ctx = uniqueMpuMatch(line, pos, h.state.cmdNames)
	}
	if ctx == h.last {
		return nil, 0, false
	}
	h.last = ctx
	h.state.rl.SetPrompt(h.buildPrompt(ctx))
	return nil, 0, false
}

// buildPrompt is the OnChange-safe version that uses only the precomputed
// cache — never touches Janet.
func (h *hintRenderer) buildPrompt(ctx string) string {
	base := h.basePrompt()
	if ctx == "" {
		return base
	}
	if block, ok := h.cache[ctx]; ok && block != "" {
		return block + base
	}
	return base
}

// basePrompt returns the standard numbered prompt. Safe to call from any
// goroutine — it just formats a string from state.counter.
func (h *hintRenderer) basePrompt() string {
	return fmt.Sprintf("\033[1;36mmpu\033[0m:\033[33m%d\033[0m> ", h.state.counter)
}

// uniqueMpuMatch returns the full name (e.g. "mpu/batch-get") of the only
// mpu command starting with the word at the cursor, or "" when the match
// is ambiguous/absent. Used so the hint appears while the user is still
// typing once the prefix is unambiguous.
func uniqueMpuMatch(line []rune, pos int, cmdNames []string) string {
	word := extractCurrentWord(string(line[:pos]))
	if !strings.HasPrefix(word, "mpu/") || word == "mpu/" {
		return ""
	}
	short := word[len("mpu/"):]
	var match string
	for _, name := range cmdNames {
		if strings.HasPrefix(name, short) {
			if match != "" {
				return "" // ambiguous
			}
			match = name
		}
	}
	if match == "" {
		return ""
	}
	return "mpu/" + match
}

// Reset forgets the last context so the next OnChange will unconditionally
// rebuild. Used after the user commits input so the counter advances.
func (h *hintRenderer) Reset() {
	h.last = "\x00" // impossible context, forces next OnChange to re-render
}

// formatHintBlock wraps the hint text in a dim ANSI frame. The trailing
// newline ensures the input line starts fresh below the frame.
func formatHintBlock(text string) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	var sb strings.Builder
	sb.WriteString("\033[90m┌─ hint ")
	sb.WriteString(strings.Repeat("─", 40))
	sb.WriteString("\033[0m\n")
	for _, line := range lines {
		sb.WriteString("\033[90m│\033[0m ")
		sb.WriteString(line)
		sb.WriteString("\n")
	}
	sb.WriteString("\033[90m└")
	sb.WriteString(strings.Repeat("─", 48))
	sb.WriteString("\033[0m\n")
	return sb.String()
}

// detectHintContext inspects the line up to the cursor and returns the
// name of the function that the user is currently working with.
//
// Rules:
//   - Inside a call like `(mpu/get :s "ID" ` → returns "mpu/get".
//   - Cursor still on the function name itself (no trailing space) → "".
//   - No enclosing call → "".
//
// Matches the Lisp-way nature of the REPL: the hint follows the enclosing
// s-expression, not the word being typed, because that's the function whose
// arguments the user is actually composing.
func detectHintContext(line string, pos int) string {
	if pos > len(line) {
		pos = len(line)
	}
	prefix := line[:pos]
	if prefix == "" {
		return ""
	}

	// Find the innermost unmatched '(' scanning right-to-left, skipping
	// quoted strings. Mirrors complete/enclosing-call in completion.janet
	// but lives here so Listener doesn't have to cross into Janet on every
	// keystroke.
	open := -1
	depth := 0
	inStr := false
	escape := false
	for i := len(prefix) - 1; i >= 0; i-- {
		c := prefix[i]
		if inStr {
			if c == '"' && !backslashedAt(prefix, i) {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			continue
		}
		_ = escape
		switch c {
		case ')':
			depth++
		case '(':
			if depth == 0 {
				open = i
				i = -1
			} else {
				depth--
			}
		}
	}
	if open < 0 {
		return ""
	}

	// Extract the symbol that follows '(' up to the first whitespace/paren.
	start := open + 1
	end := start
	for end < len(prefix) {
		c := prefix[end]
		if c == ' ' || c == '\t' || c == '\n' ||
			c == '(' || c == ')' || c == '[' || c == ']' ||
			c == '{' || c == '}' || c == '"' {
			break
		}
		end++
	}
	if end == start {
		return ""
	}
	name := prefix[start:end]

	// If the cursor is still inside (or at the end of) the name and nothing
	// comes after it yet, the user is typing the name — no hint yet.
	if end == len(prefix) {
		return ""
	}
	return name
}

// backslashedAt reports whether the character at i is preceded by an odd
// number of backslashes (i.e. it is escaped).
func backslashedAt(s string, i int) bool {
	n := 0
	for j := i - 1; j >= 0 && s[j] == '\\'; j-- {
		n++
	}
	return n%2 == 1
}

// Compile-time interface check — Listener requires OnChange with this signature.
var _ readline.Listener = (*hintRenderer)(nil)
