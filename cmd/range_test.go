package cmd

import (
	"testing"
)

// parseRangeStart contract from cmd/webapp_batch_get_all.go must survive
// the move to cmd/range.go — existing merge logic relies on the (col,row)
// tuple being exactly what the old implementation returned.
func TestParseRangeStart_LegacyContract(t *testing.T) {
	cases := []struct {
		in      string
		wantCol int
		wantRow int
	}{
		{"A1", 0, 1},
		{"A1:B2", 0, 1},
		{"Sheet!A1:B2", 0, 1},
		{"'Sheet Name'!A1:B2", 0, 1},
		{"R4:T6", 17, 4}, // R = col 17 (0-based), row 4
		{"UNIT!R4:T6", 17, 4},
		{"T6", 19, 6},
		{"ZZZ1", 18277, 1}, // 3-letter column
		{"A:ZZZ", 0, 1},    // open-ended → (0,1)
		{"bogus", 0, 1},    // unparseable → (0,1)
	}
	for _, tc := range cases {
		gotCol, gotRow := parseRangeStart(tc.in)
		if gotCol != tc.wantCol || gotRow != tc.wantRow {
			t.Errorf("parseRangeStart(%q) = (%d,%d), want (%d,%d)",
				tc.in, gotCol, gotRow, tc.wantCol, tc.wantRow)
		}
	}
}

// colToLetters must handle 3-letter columns (ZZZ = 18277).
func TestColToLetters_Extended(t *testing.T) {
	cases := []struct {
		in   int
		want string
	}{
		{0, "A"},
		{25, "Z"},
		{26, "AA"},
		{17, "R"},
		{19, "T"},
		{18277, "ZZZ"},
	}
	for _, tc := range cases {
		if got := colToLetters(tc.in); got != tc.want {
			t.Errorf("colToLetters(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// parseRangeRect produces the full bounding box for both bounded and
// open-ended forms — this is what the cache bridge uses to look up
// covering fetches.
func TestParseRangeRect(t *testing.T) {
	cases := []struct {
		in                             string
		wantSheet                      string
		wantC1, wantR1, wantC2, wantR2 int
	}{
		{"A1:B2", "", 0, 1, 1, 2},
		{"Sheet!A1:B2", "Sheet", 0, 1, 1, 2},
		{"'Sheet Name'!A1:B2", "Sheet Name", 0, 1, 1, 2},
		{"UNIT!R4:T6", "UNIT", 17, 4, 19, 6},
		{"UNIT!A:ZZZ", "UNIT", 0, 1, 18277, rowUnbounded},
		{"UNIT!A1", "UNIT", 0, 1, 0, 1}, // single cell
	}
	for _, tc := range cases {
		sheet, c1, r1, c2, r2, _, err := parseRangeRect(tc.in)
		if err != nil {
			t.Errorf("parseRangeRect(%q): unexpected err %v", tc.in, err)
			continue
		}
		if sheet != tc.wantSheet {
			t.Errorf("parseRangeRect(%q) sheet = %q, want %q", tc.in, sheet, tc.wantSheet)
		}
		if c1 != tc.wantC1 || r1 != tc.wantR1 || c2 != tc.wantC2 || r2 != tc.wantR2 {
			t.Errorf("parseRangeRect(%q) rect = (%d,%d,%d,%d), want (%d,%d,%d,%d)",
				tc.in, c1, r1, c2, r2, tc.wantC1, tc.wantR1, tc.wantC2, tc.wantR2)
		}
	}
}
