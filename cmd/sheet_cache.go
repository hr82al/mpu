package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"mpu/internal/cache"
	"mpu/internal/defaults"
	"mpu/internal/webapp"
)

// sheetCell is the unit of the merged batch-get-all output. Kept in
// package scope (the previous inline definition in mergeValuesAndFormulas
// is now replaced) so both the cache bridge and Janet consumers see the
// same JSON shape: {"a":..., "v":..., "f":...}.
type sheetCell struct {
	A string `json:"a"`
	V any    `json:"v"`
	F string `json:"f"`
}

// sheetRange is one returned range in the merged batch-get-all output.
type sheetRange struct {
	Range  string        `json:"range"`
	Values [][]sheetCell `json:"values"`
}

// sheetFetch describes one call through the cache bridge. batch-get-all
// sets wantValue = wantFormula = true; batch-get sets exactly one based
// on --value-render. FORMATTED_VALUE is handled by the caller bypassing
// the bridge entirely.
type sheetFetch struct {
	spreadsheetID string
	ranges        []string
	wantValue     bool
	wantFormula   bool
}

// run executes the batch fetch, honouring forceCache modes and
// populating the per-cell cache along the way. It returns one sheetRange
// per requested range, in request order.
func (f sheetFetch) run(cfg defaults.Config, client webapp.Client) ([]sheetRange, error) {
	if !f.wantValue && !f.wantFormula {
		return nil, fmt.Errorf("sheetFetch: at least one of wantValue/wantFormula must be true")
	}

	db, err := cache.Open()
	if err != nil {
		return nil, fmt.Errorf("open cache: %w", err)
	}
	defer db.Close()

	out := make([]sheetRange, len(f.ranges))
	for i, rng := range f.ranges {
		sheet, c1, r1, c2, r2, _, err := parseRangeRect(rng)
		if err != nil {
			return nil, fmt.Errorf("parse %q: %w", rng, err)
		}
		if sheet == "" {
			return nil, fmt.Errorf("range %q lacks a sheet name; use 'Sheet!A1:B2'", rng)
		}

		served, err := f.serveFromCache(db, cfg, sheet, c1, r1, c2, r2, rng)
		if err != nil {
			return nil, err
		}
		if served != nil {
			out[i] = *served
			continue
		}
		if cfg.ForceCache == defaults.CacheModeUse {
			return nil, fmt.Errorf("no cached data for %q (forceCache=use); "+
				"run the same command without forceCache=use to populate cache first", rng)
		}

		// Cache miss (or accumulate mode): fetch from API and persist.
		fetched, err := f.fetchAndStore(db, client, sheet, rng)
		if err != nil {
			return nil, err
		}
		out[i] = fetched
	}
	return out, nil
}

// serveFromCache returns a sheetRange built from sheet_cells when the
// request is fully covered by a prior fetch and (for TTL modes) still
// fresh. Returns (nil, nil) on miss. In accumulate mode, always misses
// so the caller re-fetches.
func (f sheetFetch) serveFromCache(
	db *cache.DB, cfg defaults.Config,
	sheet string, c1, r1, c2, r2 int, rng string,
) (*sheetRange, error) {
	if cfg.ForceCache == defaults.CacheModeAccumulate {
		return nil, nil
	}

	_, fetchedAt, ok, err := db.FindCoveringFetch(
		f.spreadsheetID, sheet, r1, c1, r2, c2, f.wantValue, f.wantFormula,
	)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	if ttl, hasTTL := cfg.CacheTTL(); hasTTL {
		if time.Since(fetchedAt) > ttl {
			return nil, nil
		}
	}

	stored, err := db.GetSheetCells(f.spreadsheetID, sheet, r1, c1, r2, c2)
	if err != nil {
		return nil, err
	}
	return buildRangeFromCells(rng, sheet, stored, r1, c1, r2, c2), nil
}

// fetchAndStore hits the API once per requested render, merges the
// result, upserts non-empty cells into sheet_cells, and records the
// fetch rectangle so later subset requests can hit the cache.
func (f sheetFetch) fetchAndStore(
	db *cache.DB, client webapp.Client,
	sheet, rng string,
) (sheetRange, error) {
	var valResp, fmlResp *webapp.Response
	fetch := func(vro string) (*webapp.Response, error) {
		resp, err := client.Do(webapp.Request{
			"action":               "spreadsheets/values/batchGet",
			"ssId":                 f.spreadsheetID,
			"ranges":               []string{rng},
			"majorDimension":       "ROWS",
			"valueRenderOption":    vro,
			"dateTimeRenderOption": "SERIAL_NUMBER",
		})
		if err != nil {
			return nil, err
		}
		if err := checkResp(resp); err != nil {
			return nil, err
		}
		return resp, nil
	}

	if f.wantValue {
		r, err := fetch("UNFORMATTED_VALUE")
		if err != nil {
			return sheetRange{}, err
		}
		valResp = r
	}
	if f.wantFormula {
		r, err := fetch("FORMULA")
		if err != nil {
			return sheetRange{}, err
		}
		fmlResp = r
	}

	merged, err := mergeResponses(valResp, fmlResp)
	if err != nil {
		return sheetRange{}, fmt.Errorf("merge response: %w", err)
	}
	if len(merged) == 0 {
		return sheetRange{Range: rng}, nil
	}
	primary := merged[0]

	// Translate to SheetCell for the cache.
	cells := make([]cache.SheetCell, 0, 128)
	for _, row := range primary.Values {
		for _, cell := range row {
			sc := cache.SheetCell{Address: cell.A}
			if f.wantValue {
				v := sprintValue(cell.V)
				sc.Value = &v
			}
			if f.wantFormula {
				fval := cell.F
				sc.Formula = &fval
			}
			cells = append(cells, sc)
		}
	}

	// Parse the request's bounding rect. ReplaceSheetCellsInRect evicts
	// any stored cells inside the box that are absent from this fresh
	// response — without that step, a cell the user cleared in Sheets
	// would keep reappearing from cache forever.
	_, rc1, rr1, rc2, rr2, _, parseErr := parseRangeRect(rng)
	if parseErr != nil {
		// Fall back to pure upsert if the range wouldn't parse; at least
		// we keep data flowing even if stale-eviction is skipped.
		if err := db.UpsertSheetCells(f.spreadsheetID, sheet, cells); err != nil {
			return sheetRange{}, fmt.Errorf("upsert: %w", err)
		}
	} else {
		if err := db.ReplaceSheetCellsInRect(
			f.spreadsheetID, sheet, rr1, rc1, rr2, rc2, cells,
		); err != nil {
			return sheetRange{}, fmt.Errorf("replace in rect: %w", err)
		}
		if err := db.RecordSheetFetch(
			f.spreadsheetID, sheet, rr1, rc1, rr2, rc2,
			f.wantValue, f.wantFormula,
		); err != nil {
			return sheetRange{}, fmt.Errorf("record fetch: %w", err)
		}
	}
	return primary, nil
}

// mergeResponses overlays value and formula responses into sheetRanges.
// Either response may be nil when the caller only needs one render;
// missing cells become empty strings on that side.
func mergeResponses(val, fml *webapp.Response) ([]sheetRange, error) {
	var valResult, fmlResult batchGetResult
	if val != nil {
		if err := json.Unmarshal(val.Result, &valResult); err != nil {
			return nil, fmt.Errorf("parse values response: %w", err)
		}
	}
	if fml != nil {
		if err := json.Unmarshal(fml.Result, &fmlResult); err != nil {
			return nil, fmt.Errorf("parse formulas response: %w", err)
		}
	}

	n := max(len(valResult.ValueRanges), len(fmlResult.ValueRanges))
	out := make([]sheetRange, 0, n)
	for i := 0; i < n; i++ {
		var vr, fr valueRange
		if i < len(valResult.ValueRanges) {
			vr = valResult.ValueRanges[i]
		}
		if i < len(fmlResult.ValueRanges) {
			fr = fmlResult.ValueRanges[i]
		}
		rangeStr := vr.Range
		if rangeStr == "" {
			rangeStr = fr.Range
		}

		startCol, startRow := parseRangeStart(rangeStr)
		rows := max(len(vr.Values), len(fr.Values))
		merged := make([][]sheetCell, rows)
		for r := range rows {
			var valRow, fmlRow []any
			if r < len(vr.Values) {
				valRow = vr.Values[r]
			}
			if r < len(fr.Values) {
				fmlRow = fr.Values[r]
			}
			cols := max(len(valRow), len(fmlRow))
			merged[r] = make([]sheetCell, cols)
			for c := range cols {
				var v, rawF any
				if c < len(valRow) {
					v = valRow[c]
				}
				if c < len(fmlRow) {
					rawF = fmlRow[c]
				}
				f := sprintValue(rawF)
				vStr := sprintValue(v)
				formula := ""
				if f != vStr {
					formula = f
				}
				addr := colToLetters(startCol+c) + strconv.Itoa(startRow+r)
				merged[r][c] = sheetCell{A: addr, V: v, F: formula}
			}
		}
		out = append(out, sheetRange{Range: rangeStr, Values: merged})
	}
	return out, nil
}

// buildRangeFromCells reconstructs a sheetRange from stored cells to
// mirror the shape the Apps Script API would have returned:
//
//   - Rows with no stored cells in [r1..r2] are omitted entirely —
//     the API trims leading/trailing empty rows.
//   - Within each emitted row we go from leftmost to rightmost stored
//     column and synthesise empties in the gaps (so a cleared cell in
//     the middle of a dense row still appears as {V:"" F:""}).
//   - Per-row trailing empties are not emitted.
//
// This keeps the output tiny for sparse sheets — a full-sheet cache hit
// for a sheet with ~6000 non-empty cells costs ~6000 cells to emit, not
// maxRow × 18278 cells (the ZZZ bound of the default "A:ZZZ" request).
func buildRangeFromCells(
	rng, sheet string, stored []cache.SheetCell,
	r1, c1, r2, c2 int,
) *sheetRange {
	// Group stored cells by row, tracking the min/max observed column
	// per row so we can emit mid-row gaps as empties while skipping
	// rows that have no data at all.
	type rowData struct {
		byCol  map[int]cache.SheetCell
		minCol int
		maxCol int
	}
	rows := map[int]*rowData{}
	minRow, maxRow := -1, -1
	for _, cell := range stored {
		r, c, ok := parseAddressRC(cell.Address)
		if !ok || r < r1 || r > r2 || c < c1 || c > c2 {
			continue
		}
		rd, exists := rows[r]
		if !exists {
			rd = &rowData{byCol: map[int]cache.SheetCell{}, minCol: c, maxCol: c}
			rows[r] = rd
			if minRow < 0 || r < minRow {
				minRow = r
			}
			if r > maxRow {
				maxRow = r
			}
		}
		rd.byCol[c] = cell
		if c < rd.minCol {
			rd.minCol = c
		}
		if c > rd.maxCol {
			rd.maxCol = c
		}
	}

	if minRow < 0 {
		// Nothing in the rect — return empty range (same as API).
		return &sheetRange{Range: rng, Values: [][]sheetCell{}}
	}

	values := make([][]sheetCell, 0, maxRow-minRow+1)
	for r := minRow; r <= maxRow; r++ {
		rd := rows[r]
		if rd == nil {
			// Row has no stored data — emit empty row (API returns []).
			values = append(values, []sheetCell{})
			continue
		}
		rowOut := make([]sheetCell, rd.maxCol-rd.minCol+1)
		for c := rd.minCol; c <= rd.maxCol; c++ {
			addr := colToLetters(c) + strconv.Itoa(r)
			if stored, ok := rd.byCol[c]; ok {
				rowOut[c-rd.minCol] = sheetCell{
					A: addr,
					V: derefOrEmpty(stored.Value),
					F: derefOrEmpty(stored.Formula),
				}
			} else {
				rowOut[c-rd.minCol] = sheetCell{A: addr, V: "", F: ""}
			}
		}
		values = append(values, rowOut)
	}
	return &sheetRange{Range: rng, Values: values}
}

// parseAddressRC decodes "T6" into (row=6, col=19). Kept separate from
// parseRangeRect so the bridge can work with single-cell labels without
// invoking the full range grammar.
func parseAddressRC(addr string) (row, col int, ok bool) {
	c, r, good := parseRangeEndpoint(addr, -1, -1)
	if !good || c < 0 || r < 0 {
		return 0, 0, false
	}
	return r, c, true
}

// sprintValue mimics the fmt.Sprint(any) behaviour already used by the
// legacy mergeValuesAndFormulas so cell comparisons (value vs formula)
// stay byte-compatible with the original contract.
func sprintValue(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	default:
		return fmt.Sprint(x)
	}
}

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
