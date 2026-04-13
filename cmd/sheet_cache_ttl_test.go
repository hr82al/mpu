package cmd

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"mpu/internal/cache"
	"mpu/internal/defaults"
)

// After a batch-get (formula-only) touches a rect, a subsequent
// batch-get-all for the same rect must return the values that were
// cached by the first batch-get-all — not blank values.
//
// Bug this covers: batch-get wipes all cells in the rect (values from
// prior batch-get-all are evicted), but the older sheet_fetches row
// still claims has_value=1. The next batch-get-all sees a "covering"
// fetch with values, reads from (now empty) sheet_cells, and returns
// blank values instead of the previously cached ones.
func TestSheetCache_BatchGetDoesNotInvalidateValues(t *testing.T) {
	setupTest(t)

	installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 1, "B1": 2,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": "=1", "B1": "=2",
		}),
	})

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B1"); err != nil {
		t.Fatalf("seed batch-get-all: %v", err)
	}
	if err := run("batch-get", "-s", "ss", "-r", "UNIT!A1:B1",
		"--value-render", "FORMULA"); err != nil {
		t.Fatalf("batch-get formula-only: %v", err)
	}

	buf := &bytes.Buffer{}
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"batch-get-all", "-s", "ss", "-r", "UNIT!A1:B1"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("second batch-get-all: %v", err)
	}
	var parsed []struct {
		Values [][]struct {
			A string `json:"a"`
			V any    `json:"v"`
			F string `json:"f"`
		} `json:"values"`
	}
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal: %v — got %s", err, buf.String())
	}
	if len(parsed) == 0 || len(parsed[0].Values) == 0 {
		t.Fatalf("empty output: %s", buf.String())
	}
	row := parsed[0].Values[0]
	if len(row) < 2 {
		t.Fatalf("row length: got %d, want ≥2", len(row))
	}
	if fmtAny(row[0].V) != "1" {
		t.Errorf("A1 value lost after batch-get formula-only: v=%v (want 1)", row[0].V)
	}
	if fmtAny(row[1].V) != "2" {
		t.Errorf("B1 value lost after batch-get formula-only: v=%v (want 2)", row[1].V)
	}
}

// Regression driving the ss-analyze failure: after a value-only
// batch-get refetches a rect that a prior batch-get-all had already
// populated with formulas, the formulas must survive. The earlier
// ReplaceSheetCellsInRect wiped the whole row on insert, so a
// subsequent batch-get-all "cache hit" returned formula="" for every
// cell. Downstream tooling (ss-analyze) then couldn't find any
// source cell and errored. Numeric TTL mode is used so the batch-get
// refetch actually runs instead of being cache-served.
func TestSheetCache_ValueOnlyRefetchPreservesFormulas(t *testing.T) {
	home, _ := setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 1, "B1": 5,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
			"A1": 1, "B1": "=A1+4",
		}),
	})

	// Seed both renders via batch-get-all.
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B1"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Switch to 1-second TTL and wait past it so the batch-get
	// actually refetches rather than serving from cache.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheMode("1"),
		Defaults:   make(defaults.Values),
	})
	time.Sleep(1100 * time.Millisecond)

	// Change mock to return only values for the refetch.
	mc.byRender["UNFORMATTED_VALUE"] = buildBatchGetResp("UNIT!A1:B1", 1, 2, map[string]any{
		"A1": 1, "B1": 5,
	})
	if err := run("batch-get", "-s", "ss", "-r", "UNIT!A1:B1",
		"--value-render", "UNFORMATTED_VALUE"); err != nil {
		t.Fatalf("batch-get value-only: %v", err)
	}

	// Flip TTL wide open so the subsequent batch-get-all can serve
	// from cache if the data still supports it.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheMode("3600"),
		Defaults:   make(defaults.Values),
	})

	db, _ := cache.Open()
	defer db.Close()
	cells, _ := db.GetSheetCells("ss", "UNIT", 1, 0, 1, 1)
	got := map[string]string{}
	for _, c := range cells {
		f := ""
		if c.Formula != nil {
			f = *c.Formula
		}
		got[c.Address] = f
	}
	if got["B1"] != "=A1+4" {
		t.Errorf("B1 formula wiped by value-only refetch: got %q, want %q",
			got["B1"], "=A1+4")
	}
}

// Regression: a numeric forceCache TTL must actually serve cached
// responses within the window. The bug was silent: the sqlite driver
// returns fetched_at in RFC3339 form ("2026-04-13T03:24:04Z"), but
// FindCoveringFetch parsed it as "2006-01-02 15:04:05" and dropped
// the error — fetchedAt became the zero time, time.Since was ~2000
// years, and every request appeared "stale" and refetched.
func TestSheetCache_TTLServesFreshCacheWithinWindow(t *testing.T) {
	home, _ := setupTest(t)

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{
			"A1": 1, "B2": 4,
		}),
		"FORMULA": buildBatchGetResp("UNIT!A1:B2", 2, 2, map[string]any{
			"A1": 1, "B2": "=A1+3",
		}),
	})

	// First call seeds both renders.
	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	firstCalls := mc.calls

	// Switch to numeric TTL (1 hour); the just-seeded entry is fresh.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheMode("3600"),
		Defaults:   make(defaults.Values),
	})

	if err := run("batch-get-all", "-s", "ss", "-r", "UNIT!A1:B2"); err != nil {
		t.Fatalf("second: %v", err)
	}
	if mc.calls != firstCalls {
		t.Errorf("TTL-mode cache miss on fresh entry: calls went %d → %d "+
			"(likely fetched_at parse failure — regression of the RFC3339 vs "+
			"DateTime layout bug)", firstCalls, mc.calls)
	}
}

// A TTL-mode request must auto-evict sheet_fetches and sheet_cells
// older than (now - ttl) so stale data doesn't accumulate forever.
func TestSheetCache_TTLEvictsExpiredEntriesOnRequest(t *testing.T) {
	home, _ := setupTest(t)

	// Seed the cache with an entry that is already 'old'.
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("cache open: %v", err)
	}
	oldAddr := "A1"
	oldVal := "old"
	if err := db.UpsertSheetCells("ss", "STALE", []cache.SheetCell{{
		Address: oldAddr, Value: &oldVal,
	}}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := db.RecordSheetFetch("ss", "STALE", 1, 0, 1, 0, true, false); err != nil {
		t.Fatalf("record: %v", err)
	}
	// Back-date everything by 1 hour.
	oneHourAgo := time.Now().Add(-1 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := db.Exec(
		`UPDATE sheet_cells SET created_at = ? WHERE sheet_name = 'STALE'`, oneHourAgo,
	); err != nil {
		t.Fatalf("backdate cells: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE sheet_fetches SET fetched_at = ? WHERE sheet_name = 'STALE'`, oneHourAgo,
	); err != nil {
		t.Fatalf("backdate fetches: %v", err)
	}
	db.Close()

	// TTL = 60 seconds — everything older than 60s must be evicted when a
	// subsequent request runs.
	writeConfig(t, home, defaults.Config{
		ForceCache: defaults.CacheMode("60"),
		Defaults:   make(defaults.Values),
	})

	// Fire an unrelated request so eviction runs. We don't care about its
	// output; we just need sheetFetch.run() to execute.
	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("FRESH!A1:A1", 1, 1, map[string]any{"A1": 1}),
		"FORMULA":           buildBatchGetResp("FRESH!A1:A1", 1, 1, map[string]any{"A1": 1}),
	})
	if err := run("batch-get-all", "-s", "ss", "-r", "FRESH!A1:A1"); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	_ = mc

	db2, err := cache.Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db2.Close()
	var nCells, nFetches int
	_ = db2.QueryRow(`SELECT COUNT(*) FROM sheet_cells WHERE sheet_name = 'STALE'`).Scan(&nCells)
	_ = db2.QueryRow(`SELECT COUNT(*) FROM sheet_fetches WHERE sheet_name = 'STALE'`).Scan(&nFetches)
	if nCells != 0 {
		t.Errorf("expired sheet_cells not evicted: %d rows remain", nCells)
	}
	if nFetches != 0 {
		t.Errorf("expired sheet_fetches not evicted: %d rows remain", nFetches)
	}
}

// In default (empty forceCache) mode — no TTL — eviction must NOT run;
// otherwise old entries vanish even though the user asked for "keep
// cache indefinitely". Regression guard.
func TestSheetCache_NoEvictionInDefaultMode(t *testing.T) {
	setupTest(t)

	db, err := cache.Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	old := "v"
	if err := db.UpsertSheetCells("ss", "OLD", []cache.SheetCell{{
		Address: "A1", Value: &old,
	}}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := db.RecordSheetFetch("ss", "OLD", 1, 0, 1, 0, true, false); err != nil {
		t.Fatalf("record: %v", err)
	}
	ancient := time.Now().Add(-365 * 24 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	_, _ = db.Exec(`UPDATE sheet_cells SET created_at = ? WHERE sheet_name = 'OLD'`, ancient)
	_, _ = db.Exec(`UPDATE sheet_fetches SET fetched_at = ? WHERE sheet_name = 'OLD'`, ancient)
	db.Close()

	mc := installBatchMock(map[string]json.RawMessage{
		"UNFORMATTED_VALUE": buildBatchGetResp("X!A1:A1", 1, 1, map[string]any{"A1": 1}),
		"FORMULA":           buildBatchGetResp("X!A1:A1", 1, 1, map[string]any{"A1": 1}),
	})
	if err := run("batch-get-all", "-s", "ss", "-r", "X!A1:A1"); err != nil {
		t.Fatalf("run: %v", err)
	}
	_ = mc

	db2, _ := cache.Open()
	defer db2.Close()
	var n int
	_ = db2.QueryRow(`SELECT COUNT(*) FROM sheet_cells WHERE sheet_name = 'OLD'`).Scan(&n)
	if n == 0 {
		t.Errorf("default-mode request evicted ancient cells; expected them preserved")
	}
}
