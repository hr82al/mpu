package cache_test

import (
	"testing"

	"mpu/internal/cache"
)

// ── helpers ───────────────────────────────────────────────────────────────

func strp(s string) *string { return &s }

// ── migration ─────────────────────────────────────────────────────────────

// Migration 6 must add sheet_cells and sheet_fetches while leaving the
// legacy webapp_cache table intact (non-batch webApp commands still use it).
func TestMigration6_CreatesSheetTables(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	for _, tbl := range []string{"sheet_cells", "sheet_fetches", "webapp_cache"} {
		var n int
		err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
			tbl,
		).Scan(&n)
		if err != nil {
			t.Fatalf("query for %s: %v", tbl, err)
		}
		if n != 1 {
			t.Errorf("table %s: expected to exist after migrate, count=%d", tbl, n)
		}
	}
}

// ── UpsertSheetCells ──────────────────────────────────────────────────────

// Cells that hold neither a value nor a formula must NOT be written — the
// whole point of the per-cell cache is to skip fully-empty cells.
func TestUpsertSheetCells_SkipsEmpty(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	cells := []cache.SheetCell{
		{Address: "A1", Value: strp("1"), Formula: nil},
		{Address: "A2", Value: nil, Formula: nil},           // empty → skip
		{Address: "A3", Value: strp(""), Formula: strp("")}, // empty literals → skip
		{Address: "B1", Value: nil, Formula: strp("=A1+1")}, // formula only
	}
	if err := db.UpsertSheetCells("ss", "UNIT", cells); err != nil {
		t.Fatalf("UpsertSheetCells: %v", err)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sheet_cells`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Errorf("rows: got %d, want 2 (A1 + B1)", n)
	}
}

// Re-upserting the same address must overwrite the previous row, not
// duplicate it. Primary key is (spreadsheet_id, address, sheet_name).
func TestUpsertSheetCells_ReplacesByPK(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("old")},
	})
	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("new"), Formula: strp("=B1")},
	})

	got, err := db.GetSheetCells("ss", "UNIT", 1, 0, 1, 0)
	if err != nil {
		t.Fatalf("GetSheetCells: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len: got %d rows, want 1", len(got))
	}
	if got[0].Value == nil || *got[0].Value != "new" {
		t.Errorf("value: got %v, want \"new\"", got[0].Value)
	}
	if got[0].Formula == nil || *got[0].Formula != "=B1" {
		t.Errorf("formula: got %v, want \"=B1\"", got[0].Formula)
	}
}

// Same address in different sheets or different spreadsheets must coexist.
func TestUpsertSheetCells_PerSheetIsolation(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("unit-a1")},
	})
	_ = db.UpsertSheetCells("ss", "OTHER", []cache.SheetCell{
		{Address: "A1", Value: strp("other-a1")},
	})
	_ = db.UpsertSheetCells("ss2", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("ss2-unit-a1")},
	})

	unit, _ := db.GetSheetCells("ss", "UNIT", 1, 0, 1, 0)
	other, _ := db.GetSheetCells("ss", "OTHER", 1, 0, 1, 0)
	ss2, _ := db.GetSheetCells("ss2", "UNIT", 1, 0, 1, 0)

	if len(unit) != 1 || *unit[0].Value != "unit-a1" {
		t.Errorf("unit isolation broken: %+v", unit)
	}
	if len(other) != 1 || *other[0].Value != "other-a1" {
		t.Errorf("other isolation broken: %+v", other)
	}
	if len(ss2) != 1 || *ss2[0].Value != "ss2-unit-a1" {
		t.Errorf("ss2 isolation broken: %+v", ss2)
	}
}

// ── GetSheetCells rectangle query ────────────────────────────────────────

// Rectangle query filters by row/col bounding box. Stored addresses
// outside the bbox must not appear in the result.
func TestGetSheetCells_RectFilters(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("a1")},
		{Address: "R4", Value: strp("r4"), Formula: strp("=ARRAYFORMULA()")},
		{Address: "T6", Value: strp("t6")},
		{Address: "Z99", Value: strp("z99")},
	})

	// Bounding box rows 4..6, cols 18..20 (R..T, 0-based 17..19).
	got, err := db.GetSheetCells("ss", "UNIT", 4, 17, 6, 19)
	if err != nil {
		t.Fatalf("GetSheetCells: %v", err)
	}
	want := map[string]bool{"R4": true, "T6": true}
	if len(got) != len(want) {
		t.Fatalf("rows: got %d, want %d; rows=%+v", len(got), len(want), got)
	}
	for _, c := range got {
		if !want[c.Address] {
			t.Errorf("unexpected address in result: %q", c.Address)
		}
	}
}

// A cell that existed before but is absent from a fresh fetch (because
// the user cleared it) must disappear from the cache too — otherwise
// subsequent cache-served requests return stale content masquerading as
// live data. ReplaceSheetCellsInRect is the atomic primitive: delete
// everything inside the rect, then insert the fresh non-empty cells.
func TestReplaceSheetCellsInRect_ClearsStaleCells(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// First "fetch" inserts three non-empty cells.
	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("1")},
		{Address: "B1", Value: strp("2")},
		{Address: "C1", Value: strp("3")},
	})

	// Second fetch of the same rect (A1:C1) returns only A1 — B1 and C1
	// were cleared in the sheet. Both must be evicted.
	err := db.ReplaceSheetCellsInRect("ss", "UNIT",
		1, 0, 1, 2, // r1,c1,r2,c2
		[]cache.SheetCell{
			{Address: "A1", Value: strp("still-here")},
		})
	if err != nil {
		t.Fatalf("ReplaceSheetCellsInRect: %v", err)
	}

	got, _ := db.GetSheetCells("ss", "UNIT", 1, 0, 1, 2)
	if len(got) != 1 || got[0].Address != "A1" || *got[0].Value != "still-here" {
		t.Errorf("only A1=still-here should remain, got %+v", got)
	}
}

// Cells OUTSIDE the replaced rect must be preserved — we're cleaning
// stale data only within what we just fetched.
func TestReplaceSheetCellsInRect_PreservesOutsideRect(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.UpsertSheetCells("ss", "UNIT", []cache.SheetCell{
		{Address: "A1", Value: strp("inside")},
		{Address: "Z99", Value: strp("outside")},
	})

	// Replace only the (1,0)..(1,0) box — Z99 must survive.
	_ = db.ReplaceSheetCellsInRect("ss", "UNIT", 1, 0, 1, 0, []cache.SheetCell{
		{Address: "A1", Value: strp("new")},
	})

	got, _ := db.GetSheetCells("ss", "UNIT", 1, 0, 100, 100)
	addrs := map[string]string{}
	for _, c := range got {
		if c.Value != nil {
			addrs[c.Address] = *c.Value
		}
	}
	if addrs["A1"] != "new" {
		t.Errorf("A1 should be updated: %v", addrs)
	}
	if addrs["Z99"] != "outside" {
		t.Errorf("Z99 must survive the replacement: %v", addrs)
	}
}

// ── sheet_fetches / FindCoveringFetch ────────────────────────────────────

// A fetched rect that fully contains the request (rows AND cols) should
// register as a cache hit when the caller's has_value/has_formula
// requirements are met.
func TestFindCoveringFetch_ContainingRectHits(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	if err := db.RecordSheetFetch("ss", "UNIT", 1, 0, 100, 50, true, true); err != nil {
		t.Fatalf("RecordSheetFetch: %v", err)
	}

	rect, _, ok, err := db.FindCoveringFetch("ss", "UNIT", 4, 17, 6, 19, true, true)
	if err != nil {
		t.Fatalf("FindCoveringFetch: %v", err)
	}
	if !ok {
		t.Fatal("expected covering fetch, got none")
	}
	if rect != [4]int{1, 0, 100, 50} {
		t.Errorf("rect: got %v, want [1 0 100 50]", rect)
	}
}

// has_formula=false recorded → request that needs formula must MISS.
func TestFindCoveringFetch_MissingRenderMisses(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// Fetched value-only.
	_ = db.RecordSheetFetch("ss", "UNIT", 1, 0, 100, 50, true, false)

	_, _, ok, _ := db.FindCoveringFetch("ss", "UNIT", 4, 17, 6, 19, true, true)
	if ok {
		t.Error("value-only fetch must not cover value+formula request")
	}
	// But value-only request IS covered.
	_, _, ok, _ = db.FindCoveringFetch("ss", "UNIT", 4, 17, 6, 19, true, false)
	if !ok {
		t.Error("value-only fetch must cover value-only request")
	}
}

// Request outside the recorded rect → miss.
func TestFindCoveringFetch_OutsideRectMisses(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.RecordSheetFetch("ss", "UNIT", 1, 0, 10, 10, true, true)

	_, _, ok, _ := db.FindCoveringFetch("ss", "UNIT", 20, 20, 30, 30, true, true)
	if ok {
		t.Error("request outside recorded rect must miss")
	}
}

// Other-sheet or other-spreadsheet records must not satisfy a fetch
// lookup for (ss, UNIT).
func TestFindCoveringFetch_WrongScopeMisses(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.RecordSheetFetch("ss", "OTHER", 1, 0, 100, 50, true, true)
	_ = db.RecordSheetFetch("ss2", "UNIT", 1, 0, 100, 50, true, true)

	_, _, ok, _ := db.FindCoveringFetch("ss", "UNIT", 4, 17, 6, 19, true, true)
	if ok {
		t.Error("foreign-scope records must not cover the request")
	}
}

// Multiple overlapping fetches are allowed (per spec: refill even with
// overlap). Any one of them is enough to cover the request.
func TestFindCoveringFetch_OverlapAllowed(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.RecordSheetFetch("ss", "UNIT", 1, 0, 5, 5, true, true)
	_ = db.RecordSheetFetch("ss", "UNIT", 1, 0, 100, 100, true, true)

	_, _, ok, err := db.FindCoveringFetch("ss", "UNIT", 20, 20, 30, 30, true, true)
	if err != nil {
		t.Fatalf("FindCoveringFetch: %v", err)
	}
	if !ok {
		t.Error("large overlapping fetch must cover the request")
	}
}
