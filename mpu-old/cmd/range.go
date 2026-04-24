package cmd

import (
	"fmt"
	"math"
	"strings"
)

// Range / address helpers shared by batch-get, batch-get-all, and the
// per-cell cache bridge. Row is 1-based, column is 0-based to match the
// existing storage layer (parseAddress in internal/cache/sheet_cells.go).

// rowUnbounded is the sentinel used by parseRangeRect for open-ended
// ranges like "A:ZZZ" where the caller didn't pin end-row.
const rowUnbounded = math.MaxInt32

// parseRangeStart extracts the starting (col, row) of a range string like
// "Sheet1!A1:Z100" or "A1:B2". Preserves the original contract from
// cmd/webapp_batch_get_all.go (returns (0, 1) on unparseable input).
func parseRangeStart(rangeStr string) (col, row int) {
	_, col, row, _, _, _, _ = parseRangeRect(rangeStr)
	return col, row
}

// colToLetters converts a 0-based column index back to spreadsheet
// letters: 0→A, 25→Z, 26→AA, 18277→ZZZ.
func colToLetters(col int) string {
	result := ""
	col++ // 1-based
	for col > 0 {
		col--
		result = string(rune('A'+col%26)) + result
		col /= 26
	}
	return result
}

// parseRangeRect decomposes a range string into its sheet name and
// bounding box (rows 1-based, cols 0-based, inclusive on both sides).
//
// Accepts:
//
//	"A1:B2"              → sheet=""    r1=1  c1=0  r2=2   c2=1
//	"Sheet!A1:B2"        → sheet=Sheet r1=1  c1=0  r2=2   c2=1
//	"'Sheet Name'!A:ZZZ" → sheet=Sheet Name r1=1 c1=0 r2=MAX c2=18277
//	"A1"                 → single cell treated as 1×1 rect
//
// Legacy (unparseable) inputs return (0, 1) as the start per the old
// parseRangeStart contract; err is non-nil so callers can decide.
func parseRangeRect(s string) (sheet string, c1, r1, c2, r2 int, explicitEnd bool, err error) {
	// Split off sheet prefix.
	if idx := strings.LastIndex(s, "!"); idx >= 0 {
		sheet = strings.Trim(s[:idx], "'")
		s = s[idx+1:]
	}
	startStr, endStr, hasEnd := strings.Cut(s, ":")

	var okStart, okEnd bool
	c1, r1, okStart = parseRangeEndpoint(startStr, 0, 1)
	if !okStart {
		return sheet, 0, 1, 0, 1, false, fmt.Errorf("unparseable range start: %q", startStr)
	}
	if !hasEnd {
		// Single cell — end mirrors start, but there was no ":" so the
		// range was not explicitly bounded on the right.
		return sheet, c1, r1, c1, r1, false, nil
	}
	c2, r2, okEnd = parseRangeEndpoint(endStr, -1, rowUnbounded)
	if !okEnd {
		return sheet, c1, r1, c1, r1, false, fmt.Errorf("unparseable range end: %q", endStr)
	}
	// explicitEnd is true only when the end fragment actually carried
	// content (e.g. "B2", not the empty tail of "A1:"). Callers that
	// care about "did the user cap this range?" branch on this.
	explicitEnd = endStr != ""
	// If end column was absent, propagate from start.
	if c2 < 0 {
		c2 = c1
	}
	return sheet, c1, r1, c2, r2, explicitEnd, nil
}

// parseRangeEndpoint reads one "A1" / "A" / "1" fragment. Missing parts
// fall back to (colDefault, rowDefault). Returns ok=false only on truly
// garbled input (non letter/digit characters interleaved).
func parseRangeEndpoint(s string, colDefault, rowDefault int) (col, row int, ok bool) {
	if s == "" {
		return colDefault, rowDefault, true
	}
	// Letters prefix.
	i := 0
	for i < len(s) && s[i] >= 'A' && s[i] <= 'Z' {
		i++
	}
	letters := s[:i]
	digits := s[i:]
	// Must be all digits after letters if anything follows.
	for _, ch := range digits {
		if ch < '0' || ch > '9' {
			return colDefault, rowDefault, false
		}
	}
	if letters == "" {
		col = colDefault
	} else {
		col = 0
		for _, ch := range letters {
			col = col*26 + int(ch-'A') + 1
		}
		col-- // 0-based
	}
	if digits == "" {
		row = rowDefault
	} else {
		row = 0
		for _, ch := range digits {
			row = row*10 + int(ch-'0')
		}
		if row < 1 {
			return colDefault, rowDefault, false
		}
	}
	return col, row, true
}
