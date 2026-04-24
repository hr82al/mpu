package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"mpu/internal/cache"
	"mpu/internal/defaults"
	"mpu/internal/webapp"
)

// batchMockClient returns crafted batchGet payloads keyed on the request's
// valueRenderOption. Every Do call increments a counter so tests can prove
// "the second call didn't go to the API".
type batchMockClient struct {
	byRender map[string]json.RawMessage
	calls    int
	requests []webapp.Request
}

func (m *batchMockClient) Do(req webapp.Request) (*webapp.Response, error) {
	m.calls++
	m.requests = append(m.requests, req)
	vro, _ := req["valueRenderOption"].(string)
	body, ok := m.byRender[vro]
	if !ok {
		body = m.byRender["UNFORMATTED_VALUE"]
	}
	return &webapp.Response{Success: true, Result: body}, nil
}

// buildBatchGetResp builds the JSON returned by the Apps Script backend
// for a single range. Cells are addressed by their A1 label.
func buildBatchGetResp(rangeStr string, rows, cols int, cells map[string]any) json.RawMessage {
	vals := make([][]any, rows)
	for i := range vals {
		vals[i] = make([]any, cols)
	}
	for addr, v := range cells {
		col, row := parseRangeStart(addr)
		vals[row-1][col] = v
	}
	resp := batchGetResult{
		SpreadsheetID: "ss",
		ValueRanges: []valueRange{{
			Range:          rangeStr,
			MajorDimension: "ROWS",
			Values:         vals,
		}},
	}
	data, _ := json.Marshal(resp)
	return data
}

// installBatchMock wires a mock client and returns it so tests can assert
// on call count. Must be called after setupTest so testClientFn cleanup
// restores defaults.
func installBatchMock(byRender map[string]json.RawMessage) *batchMockClient {
	mc := &batchMockClient{byRender: byRender}
	testClientFn = func() (webapp.Client, error) { return mc, nil }
	return mc
}

// ── core cache-aside: first call fetches, second call serves from cache ──

// After a successful batch-get-all, the bridge must have (a) hit the API
// once per render, (b) upserted non-empty cells into sheet_cells, and
// (c) recorded the fetched rectangle in sheet_fetches.
func TestSheetCache_FirstCallPopulatesCache(t *testing.T) {
	setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{
			"A1": 1, "B2": 4,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{
			"A1": 1, "B2": "=A1+3",
		}),
	})

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2"); err != nil {
		t.Fatalf("run: %v", err)
	}

	if mc.calls != 2 {
		t.Errorf("API calls: got %d, want 2 (one per render)", mc.calls)
	}

	// Verify cache has the non-empty cells. A1/B2 non-empty; A2/B1 empty ⇒ skipped.
	db := mustOpenCache(t)
	defer db.Close()
	cells, err := db.GetSheetCells("ss", "UNIT", 1, 0, 2, 1)
	if err != nil {
		t.Fatalf("GetSheetCells: %v", err)
	}
	got := map[string]bool{}
	for _, c := range cells {
		got[c.Address] = true
	}
	if !got["A1"] || !got["B2"] {
		t.Errorf("expected A1+B2 cached, got %v", got)
	}
	if got["A2"] || got["B1"] {
		t.Errorf("empty cells must not be stored, got %v", got)
	}

	// Verify the fetch was recorded with both renders.
	_, _, ok, err := db.FindCoveringFetch("ss", "UNIT", 1, 0, 2, 1, true, true)
	if err != nil {
		t.Fatalf("FindCoveringFetch: %v", err)
	}
	if !ok {
		t.Error("expected sheet_fetches row covering the request")
	}
}

// Second identical call in default mode must skip the API entirely.
func TestSheetCache_RepeatedCallHitsCache(t *testing.T) {
	setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{"A1": 1}),
		"FORMULA":           buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{"A1": 1}),
	})

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2"); err != nil {
		t.Fatalf("first run: %v", err)
	}
	firstCalls := mc.calls

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2"); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if mc.calls != firstCalls {
		t.Errorf("second run hit API: calls went %d → %d (expected no new calls)",
			firstCalls, mc.calls)
	}
}

// Full-sheet fetch first, then a sub-range request must come entirely
// from the cache — this is the "subset hit" path that needs sheet_fetches.
func TestSheetCache_SubsetHit(t *testing.T) {
	setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:C3", 3, 3, map[string]any{
			"A1": 1, "B2": 2, "C3": 3,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:C3", 3, 3, map[string]any{
			"A1": 1, "B2": "=A1+1", "C3": 3,
		}),
	})

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:C3"); err != nil {
		t.Fatalf("full fetch: %v", err)
	}
	before := mc.calls

	// Now ask for the inner cell only.
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!B2:B2"); err != nil {
		t.Fatalf("subset fetch: %v", err)
	}
	if mc.calls != before {
		t.Errorf("subset request hit API: %d → %d", before, mc.calls)
	}
}

// forceCache=use with a cold cache must refuse to touch the network and
// return an error like the legacy webAppCachedClient did. Config is
// written to disk because rootCmd's PersistentPreRunE reloads it on
// every invocation (so in-memory mutation of currentConfig is lost).
func TestSheetCache_UseMode_ColdCacheErrors(t *testing.T) {
	home, _ := setupTest(t)
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheModeUse,
		Defaults:   make(defaults.Values),
	})

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{"A1": 1}),
		"FORMULA":           buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{"A1": 1}),
	})

	err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2")
	if err == nil {
		t.Fatal("expected error in forceCache=use with cold cache, got nil")
	}
	if mc.calls != 0 {
		t.Errorf("use-mode must not call API, got %d calls", mc.calls)
	}
	if !strings.Contains(err.Error(), "cache") {
		t.Errorf("error should mention cache: %v", err)
	}
}

// Empty cells absent from storage must be synthesised back into the
// output so existing consumers (including ss-analyze) keep working.
// Second call runs in forceCache=use so we know cells came from cache
// synthesis rather than the mock pass-through.
func TestSheetCache_EmptyCellsSynthesised(t *testing.T) {
	home, _ := setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:C1", 1, 3, map[string]any{
			"A1": 1, "C1": 3, // B1 empty
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:C1", 1, 3, map[string]any{
			"A1": 1, "C1": 3,
		}),
	})

	// Seed cache via an initial (default-mode) run.
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:C1"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	seededCalls := mc.calls

	// Switch to cache-only via config.json so PersistentPreRunE picks it up.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheModeUse,
		Defaults:   make(defaults.Values),
	})

	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"batch-get-all", "-s", "ss", "-r", "UNIT!A1:C1"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if mc.calls != seededCalls {
		t.Errorf("cache-only synthesis hit API: %d → %d", seededCalls, mc.calls)
	}
	var parsed []struct {
		Range  string `json:"range"`
		Values [][]struct {
			A string `json:"a"`
			V any    `json:"v"`
			F string `json:"f"`
		} `json:"values"`
	}
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal output: %v — got %s", err, buf.String())
	}
	if len(parsed) == 0 || len(parsed[0].Values) == 0 {
		t.Fatalf("empty output: %s", buf.String())
	}
	row := parsed[0].Values[0]
	if len(row) != 3 {
		t.Fatalf("row length: got %d, want 3 (A1 B1 C1): %+v", len(row), row)
	}
	// B1 should appear as an empty cell (v="" f="") with its address set.
	if row[1].A != "B1" {
		t.Errorf("middle cell address: got %q, want B1", row[1].A)
	}
	if fmtAny(row[1].V) != "" || row[1].F != "" {
		t.Errorf("B1 should be empty, got v=%v f=%q", row[1].V, row[1].F)
	}
}

// After a cell is cleared in the sheet, a fresh batch-get-all fetch
// must evict the stale stored value — not leave it sitting in
// sheet_cells waiting to be served by a later cache-hit.
func TestSheetCache_ClearedCellEvicted(t *testing.T) {
	home, _ := setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 1, "B1": 2,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 1, "B1": 2,
		}),
	})
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B1"); err != nil {
		t.Fatalf("first run: %v", err)
	}

	// User wipes B1. Refetch says A1=1, B1 empty.
	mc.byRender["UNFORMATTED_VALUE"] = buildBatchGetResp("UNIT!A1:B1", 1, 2,
		map[string]any{"A1": 1})
	mc.byRender["FORMULA"] = buildBatchGetResp("UNIT!A1:B1", 1, 2,
		map[string]any{"A1": 1})

	// Force a refetch via accumulate mode — persisted to disk because
	// PersistentPreRunE reloads currentConfig on each invocation.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheModeAccumulate,
		Defaults:   make(defaults.Values),
	})
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B1"); err != nil {
		t.Fatalf("refetch: %v", err)
	}

	db := mustOpenCache(t)
	defer db.Close()
	cells, _ := db.GetSheetCells("ss", "UNIT", 1, 0, 1, 1)
	for _, c := range cells {
		if c.Address == "B1" {
			t.Errorf("B1 should have been evicted after clear, got %+v", c)
		}
	}
}

// Regression: a full-sheet request ("A:ZZZ") served from cache must NOT
// synthesise cells out to column ZZZ (18277) — otherwise ss-analyze's
// second call against a populated cache balloons to tens of millions
// of cells and takes 10+ seconds. The API itself trims each row to its
// last non-empty cell; the cache must do the same.
func TestSheetCache_FullSheetCacheEmitsSparse(t *testing.T) {
	home, _ := setupTest(t)

	// Seed a cell far to the right. The default resolveRanges turns -n
	// into "'UNIT'!A:ZZZ" — the exact shape the user runs daily.
	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:V6", 6, 22, map[string]any{
			"V6": "spilled",
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:V6", 6, 22, map[string]any{
			"V4": "=ARRAYFORMULA(V4:V6)",
		}),
	})
	if err := run("batch-get-all", "-s", "ss", "-n", "UNIT"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = mc

	// Switch to cache-only so the second run is served from sheet_cells.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheModeUse,
		Defaults:   make(defaults.Values),
	})

	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"batch-get-all", "-s", "ss", "-n", "UNIT"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("cache run: %v", err)
	}

	var parsed []struct {
		Values [][]struct {
			A string `json:"a"`
		} `json:"values"`
	}
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal: %v — got %s", err, buf.String())
	}
	if len(parsed) == 0 {
		t.Fatal("expected at least one range in output")
	}

	// Emitted cell count must be modest (~2 stored cells + gap fill), never
	// rowMax × 18277. Anything north of a few hundred here points to a
	// regression of the synthesis blowup.
	totalCells := 0
	for _, row := range parsed[0].Values {
		totalCells += len(row)
	}
	if totalCells > 200 {
		t.Errorf("cache output emitted %d cells for a 2-cell sheet — "+
			"synthesis blowup regressed", totalCells)
	}

	// Sanity: V4 and V6 must still be reachable by address.
	seen := map[string]bool{}
	for _, row := range parsed[0].Values {
		for _, c := range row {
			seen[c.A] = true
		}
	}
	if !seen["V4"] || !seen["V6"] {
		t.Errorf("expected V4 and V6 in cache output, got addresses %v", seen)
	}
}

// ── batch-get routing ─────────────────────────────────────────────────────

// batch-get --value-render=FORMATTED_VALUE must bypass the per-cell
// cache entirely — locale/format-dependent output isn't stored, so
// every invocation must reach the API.
func TestBatchGet_FormattedValueBypassesCache(t *testing.T) {
	setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"FORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{
			"A1": "$1.00", "B2": "$4.00",
		}),
	})

	// Two identical calls — both must hit the API since we bypass cache.
	if err := run("batch-get", "-s", "ss", "-r", "UNIT!A1:B2",
		"--value-render", "FORMATTED_VALUE"); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := run("batch-get", "-s", "ss", "-r", "UNIT!A1:B2",
		"--value-render", "FORMATTED_VALUE"); err != nil {
		t.Fatalf("second: %v", err)
	}
	if mc.calls != 2 {
		t.Errorf("FORMATTED_VALUE must bypass cache: got %d calls, want 2", mc.calls)
	}

	// Nothing should be in the per-cell cache.
	db := mustOpenCache(t)
	defer db.Close()
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM sheet_cells`).Scan(&n)
	if n != 0 {
		t.Errorf("sheet_cells populated by FORMATTED_VALUE path: %d rows", n)
	}
}

// batch-get --value-render=FORMULA uses the per-cell cache: cells with
// a stored formula emit the formula, cells without one emit the value.
func TestBatchGet_FormulaRenderFallsBackToValue(t *testing.T) {
	setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		// batch-get with --value-render=FORMULA asks only for FORMULA.
		"FORMULA": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 7, // no formula
			"B1": "=A1*2",
		}),
	})

	// First call: API. Second: cache. Both must show identical output.
	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"batch-get", "-s", "ss", "-r", "UNIT!A1:B1",
		"--value-render", "FORMULA"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("first: %v", err)
	}
	firstOut := buf.String()

	buf.Reset()
	rootCmd.SetArgs([]string{"batch-get", "-s", "ss", "-r", "UNIT!A1:B1",
		"--value-render", "FORMULA"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("second: %v", err)
	}
	if !strings.Contains(firstOut, "=A1*2") {
		t.Errorf("first output should contain =A1*2, got %s", firstOut)
	}
	if mc.calls != 1 {
		t.Errorf("second call should hit cache, got %d API calls", mc.calls)
	}
	// Second output must contain both the formula and the plain value
	// (fallback path), not blanks where formulas are absent.
	second := buf.String()
	if !strings.Contains(second, "=A1*2") {
		t.Errorf("cache output missing formula: %s", second)
	}
	if !strings.Contains(second, "7") {
		t.Errorf("cache output missing plain value fallback: %s", second)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

// mustOpenCache opens the SQLite cache bound to the current HOME.
func mustOpenCache(t *testing.T) *cache.DB {
	t.Helper()
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("cache.Open: %v", err)
	}
	return db
}

// fmtAny turns any JSON value into its string form for empty-check.
func fmtAny(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
