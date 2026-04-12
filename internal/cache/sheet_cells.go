package cache

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SheetCell is one row of the per-cell cache. Value and Formula use
// *string so callers can distinguish three states in SQLite:
//
//	nil        — the render wasn't fetched (column is NULL)
//	&""        — the render was fetched and the cell is literally empty
//	&"content" — the render was fetched with actual content
//
// Fully-empty cells (Value nil/"" AND Formula nil/"") are skipped by
// UpsertSheetCells — we never touch the DB for them.
type SheetCell struct {
	Address   string
	Value     *string
	Formula   *string
	CreatedAt time.Time
}

// UpsertSheetCells inserts or replaces cells for (spreadsheetID, sheetName).
// Cells whose Value and Formula are both nil or "" are silently dropped
// so sparse sheets don't balloon the table. This is additive — it never
// deletes; use ReplaceSheetCellsInRect when the caller just re-fetched
// a rectangle and needs stale-cell eviction.
func (db *DB) UpsertSheetCells(spreadsheetID, sheetName string, cells []SheetCell) error {
	if len(cells) == 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	if err := upsertCellsTx(tx, spreadsheetID, sheetName, cells); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplaceSheetCellsInRect atomically evicts every stored cell inside
// [r1..r2]×[c1..c2] for (spreadsheetID, sheetName), then inserts the
// supplied non-empty cells. Use this after a fresh fetch so a cell that
// was cleared in the sheet also disappears from the cache — otherwise
// GetSheetCells would keep returning yesterday's content for that cell.
func (db *DB) ReplaceSheetCellsInRect(
	spreadsheetID, sheetName string,
	r1, c1, r2, c2 int,
	cells []SheetCell,
) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()

	// Pull every address for the sheet so we can filter by rect in Go
	// without needing an indexed row/col column in the schema.
	rows, err := tx.Query(`
		SELECT address FROM sheet_cells
		WHERE spreadsheet_id = ? AND sheet_name = ?`,
		spreadsheetID, sheetName)
	if err != nil {
		return fmt.Errorf("enumerate: %w", err)
	}
	var victims []string
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			rows.Close()
			return err
		}
		r, c, ok := parseAddress(addr)
		if !ok {
			continue
		}
		if r >= r1 && r <= r2 && c >= c1 && c <= c2 {
			victims = append(victims, addr)
		}
	}
	rows.Close()

	if len(victims) > 0 {
		del, err := tx.Prepare(`
			DELETE FROM sheet_cells
			WHERE spreadsheet_id = ? AND sheet_name = ? AND address = ?`)
		if err != nil {
			return fmt.Errorf("prepare delete: %w", err)
		}
		for _, addr := range victims {
			if _, err := del.Exec(spreadsheetID, sheetName, addr); err != nil {
				del.Close()
				return fmt.Errorf("delete %s: %w", addr, err)
			}
		}
		del.Close()
	}

	if err := upsertCellsTx(tx, spreadsheetID, sheetName, cells); err != nil {
		return err
	}
	return tx.Commit()
}

// upsertCellsTx is the INSERT OR REPLACE loop shared by UpsertSheetCells
// and ReplaceSheetCellsInRect so the empty-cell filter lives in one place.
func upsertCellsTx(tx interface {
	Prepare(query string) (*sql.Stmt, error)
}, spreadsheetID, sheetName string, cells []SheetCell) error {
	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO sheet_cells
			(spreadsheet_id, sheet_name, address, formula, row_value, created_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'))`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, c := range cells {
		if isBlank(c.Value) && isBlank(c.Formula) {
			continue
		}
		if _, err := stmt.Exec(
			spreadsheetID, sheetName, c.Address,
			nullable(c.Formula), nullable(c.Value),
		); err != nil {
			return fmt.Errorf("upsert %s: %w", c.Address, err)
		}
	}
	return nil
}

// isBlank reports whether a *string represents an empty cell — either
// SQL NULL (nil) or the literal empty string.
func isBlank(s *string) bool { return s == nil || *s == "" }

// nullable turns a Go *string into sql.NullString so nil survives as NULL
// and a non-nil pointer (including &"") survives as its literal value.
func nullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// GetSheetCells returns every stored cell whose address falls inside the
// [r1..r2]×[c1..c2] bounding box (both inclusive, rows 1-based, cols
// 0-based — matches parseRangeStart convention in cmd/).
//
// The set is sparse: empty cells are absent. Callers synthesise them.
func (db *DB) GetSheetCells(
	spreadsheetID, sheetName string,
	r1, c1, r2, c2 int,
) ([]SheetCell, error) {
	rows, err := db.Query(`
		SELECT address, formula, row_value, created_at
		FROM sheet_cells
		WHERE spreadsheet_id = ? AND sheet_name = ?`,
		spreadsheetID, sheetName)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []SheetCell
	for rows.Next() {
		var (
			addr            string
			formula, rowVal sql.NullString
			createdAt       string
		)
		if err := rows.Scan(&addr, &formula, &rowVal, &createdAt); err != nil {
			return nil, err
		}
		r, c, ok := parseAddress(addr)
		if !ok || r < r1 || r > r2 || c < c1 || c > c2 {
			continue
		}
		cell := SheetCell{Address: addr}
		if formula.Valid {
			v := formula.String
			cell.Formula = &v
		}
		if rowVal.Valid {
			v := rowVal.String
			cell.Value = &v
		}
		// Best-effort parse; ignore error — timestamp is informational.
		cell.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		out = append(out, cell)
	}
	return out, rows.Err()
}

// parseAddress decodes "T6" into (row=6, col=19) — row 1-based, col
// 0-based. Mirrors cmd.parseRangeStart so the SQL-side filter and the
// command-side bounding-box check agree.
func parseAddress(addr string) (row, col int, ok bool) {
	i := 0
	for i < len(addr) && addr[i] >= 'A' && addr[i] <= 'Z' {
		i++
	}
	if i == 0 || i == len(addr) {
		return 0, 0, false
	}
	col = 0
	for _, ch := range addr[:i] {
		col = col*26 + int(ch-'A') + 1
	}
	col--
	row = 0
	for _, ch := range addr[i:] {
		if ch < '0' || ch > '9' {
			return 0, 0, false
		}
		row = row*10 + int(ch-'0')
	}
	if row < 1 {
		return 0, 0, false
	}
	return row, col, true
}

// RecordSheetFetch appends a new fetched-rectangle row. Overlap with
// existing rows is allowed — per spec the cache is refilled even when
// regions overlap, and the set doubles as a "what we've seen" ledger.
func (db *DB) RecordSheetFetch(
	spreadsheetID, sheetName string,
	r1, c1, r2, c2 int,
	hasValue, hasFormula bool,
) error {
	_, err := db.Exec(`
		INSERT INTO sheet_fetches
			(spreadsheet_id, sheet_name,
			 start_row, start_col, end_row, end_col,
			 has_value, has_formula, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		spreadsheetID, sheetName,
		r1, c1, r2, c2,
		boolToInt(hasValue), boolToInt(hasFormula),
	)
	return err
}

// FindCoveringFetch looks for any recorded fetch whose rectangle
// contains [r1..r2]×[c1..c2] AND satisfies the caller's render needs.
// Multiple matches: prefers the most recently fetched one so a fresh
// refill can shadow an old covering rect.
func (db *DB) FindCoveringFetch(
	spreadsheetID, sheetName string,
	r1, c1, r2, c2 int,
	needValue, needFormula bool,
) (rect [4]int, fetchedAt time.Time, ok bool, err error) {
	var (
		sb    strings.Builder
		args  []any
		where []string
	)
	where = append(where, `spreadsheet_id = ?`, `sheet_name = ?`,
		`start_row <= ?`, `start_col <= ?`, `end_row >= ?`, `end_col >= ?`)
	args = append(args, spreadsheetID, sheetName, r1, c1, r2, c2)
	if needValue {
		where = append(where, `has_value = 1`)
	}
	if needFormula {
		where = append(where, `has_formula = 1`)
	}
	sb.WriteString(`SELECT start_row, start_col, end_row, end_col, fetched_at FROM sheet_fetches WHERE `)
	sb.WriteString(strings.Join(where, ` AND `))
	sb.WriteString(` ORDER BY fetched_at DESC LIMIT 1`)

	var fetchedStr string
	row := db.QueryRow(sb.String(), args...)
	err = row.Scan(&rect[0], &rect[1], &rect[2], &rect[3], &fetchedStr)
	if errors.Is(err, sql.ErrNoRows) {
		return [4]int{}, time.Time{}, false, nil
	}
	if err != nil {
		return [4]int{}, time.Time{}, false, err
	}
	fetchedAt, _ = time.Parse("2006-01-02 15:04:05", fetchedStr)
	return rect, fetchedAt, true, nil
}
