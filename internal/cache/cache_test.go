package cache_test

import (
	"os"
	"testing"
	"time"

	"mpu/internal/cache"
)

func withTempHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func openDB(t *testing.T) *cache.DB {
	t.Helper()
	db, err := cache.Open()
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// ── DB lifecycle ──────────────────────────────────────────────────────────────

func TestOpen_CreatesDBFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	db := openDB(t)
	if db == nil {
		t.Fatal("expected non-nil DB")
	}

	path := home + "/.config/mpu/db"
	if _, err := os.Stat(path); err != nil {
		t.Errorf("DB file not created at %s: %v", path, err)
	}
}

func TestOpen_Idempotent(t *testing.T) {
	withTempHome(t)

	db1 := openDB(t)
	db1.Close()

	// Second open must succeed and migrations must not fail.
	db2 := openDB(t)
	if db2 == nil {
		t.Fatal("second Open returned nil")
	}
}

func TestOpen_MigrationsAppliedOnce(t *testing.T) {
	withTempHome(t)

	for range 3 {
		db := openDB(t)
		db.Close()
	}
	// If migrations run more than once (e.g. CREATE TABLE without IF NOT EXISTS),
	// the third Open would panic or error. Reaching here means idempotency holds.
}

// ── token cache ───────────────────────────────────────────────────────────────

func TestToken_SetAndGet(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	if err := db.SetToken("key1", "tok-abc"); err != nil {
		t.Fatalf("SetToken: %v", err)
	}

	got, ok := db.GetToken("key1", time.Hour)
	if !ok {
		t.Fatal("GetToken: expected ok=true, got false")
	}
	if got != "tok-abc" {
		t.Errorf("GetToken: got %q, want %q", got, "tok-abc")
	}
}

func TestToken_Missing(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_, ok := db.GetToken("no-such-key", time.Hour)
	if ok {
		t.Error("GetToken on missing key: expected ok=false, got true")
	}
}

func TestToken_Expired(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	if err := db.SetToken("mykey", "old-tok"); err != nil {
		t.Fatalf("SetToken: %v", err)
	}

	// maxAge of zero → always expired.
	_, ok := db.GetToken("mykey", 0)
	if ok {
		t.Error("expected expired token to return ok=false")
	}
}

func TestToken_ReplacesPrevious(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.SetToken("k", "first")
	_ = db.SetToken("k", "second")

	got, ok := db.GetToken("k", time.Hour)
	if !ok {
		t.Fatal("GetToken: expected ok=true")
	}
	if got != "second" {
		t.Errorf("expected second token, got %q", got)
	}
}

func TestToken_IndependentKeys(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.SetToken("a", "tok-a")
	_ = db.SetToken("b", "tok-b")

	gotA, _ := db.GetToken("a", time.Hour)
	gotB, _ := db.GetToken("b", time.Hour)

	if gotA != "tok-a" {
		t.Errorf("key a: got %q, want tok-a", gotA)
	}
	if gotB != "tok-b" {
		t.Errorf("key b: got %q, want tok-b", gotB)
	}
}

// ── client cache ──────────────────────────────────────────────────────────────

func makeRows(ids ...int64) []cache.ClientRow {
	rows := make([]cache.ClientRow, len(ids))
	for i, id := range ids {
		rows[i] = cache.ClientRow{
			ID:        id,
			Server:    "sl-1",
			IsActive:  true,
			IsLocked:  false,
			IsDeleted: false,
		}
	}
	return rows
}

func TestClients_ReplaceAndGetByID(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	rows := makeRows(10, 20, 30)
	if err := db.ReplaceClients(rows); err != nil {
		t.Fatalf("ReplaceClients: %v", err)
	}

	r, ok := db.GetClient(20)
	if !ok {
		t.Fatal("GetClient(20): expected ok=true, got false")
	}
	if r.ID != 20 {
		t.Errorf("ID: got %d, want 20", r.ID)
	}
	if r.Server != "sl-1" {
		t.Errorf("Server: got %q, want sl-1", r.Server)
	}
}

func TestClients_GetMissing(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_, ok := db.GetClient(999)
	if ok {
		t.Error("GetClient on missing ID: expected ok=false, got true")
	}
}

func TestClients_ReplaceIsFullReplace(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// First batch: ids 1,2,3.
	_ = db.ReplaceClients(makeRows(1, 2, 3))

	// Second batch: ids 4,5 — old ids must be gone.
	if err := db.ReplaceClients(makeRows(4, 5)); err != nil {
		t.Fatalf("ReplaceClients: %v", err)
	}

	for _, gone := range []int64{1, 2, 3} {
		if _, ok := db.GetClient(gone); ok {
			t.Errorf("client %d should have been replaced, but still found", gone)
		}
	}
	for _, present := range []int64{4, 5} {
		if _, ok := db.GetClient(present); !ok {
			t.Errorf("client %d should be present after replace", present)
		}
	}
}

func TestClients_ReplaceIsAtomic(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// Seed with known data.
	_ = db.ReplaceClients(makeRows(1))

	// ReplaceClients with an empty slice: old data is cleared.
	if err := db.ReplaceClients([]cache.ClientRow{}); err != nil {
		t.Fatalf("ReplaceClients with empty: %v", err)
	}
	if _, ok := db.GetClient(1); ok {
		t.Error("client 1 should be gone after replacing with empty slice")
	}
}

func TestClients_HasClients_Empty(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	if db.HasClients() {
		t.Error("HasClients: expected false on empty table, got true")
	}
}

func TestClients_HasClients_Populated(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.ReplaceClients(makeRows(1))

	if !db.HasClients() {
		t.Error("HasClients: expected true after insert, got false")
	}
}

func TestClients_ListClientIDs_Empty(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	ids, err := db.ListClientIDs()
	if err != nil {
		t.Fatalf("ListClientIDs: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty list, got %v", ids)
	}
}

func TestClients_ListClientIDs_Sorted(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	_ = db.ReplaceClients(makeRows(30, 10, 20))

	ids, err := db.ListClientIDs()
	if err != nil {
		t.Fatalf("ListClientIDs: %v", err)
	}
	want := []string{"10", "20", "30"}
	if len(ids) != len(want) {
		t.Fatalf("len: got %d, want %d", len(ids), len(want))
	}
	for i, w := range want {
		if ids[i] != w {
			t.Errorf("ids[%d]: got %q, want %q", i, ids[i], w)
		}
	}
}

func TestClients_BooleanFields(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	row := cache.ClientRow{
		ID:        99,
		Server:    "sl-2",
		IsActive:  false,
		IsLocked:  true,
		IsDeleted: true,
	}
	_ = db.ReplaceClients([]cache.ClientRow{row})

	r, ok := db.GetClient(99)
	if !ok {
		t.Fatal("GetClient: expected ok=true")
	}
	if r.IsActive {
		t.Error("IsActive: expected false")
	}
	if !r.IsLocked {
		t.Error("IsLocked: expected true")
	}
	if !r.IsDeleted {
		t.Error("IsDeleted: expected true")
	}
}

func TestClients_NullableTimeFields(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	ts := time.Date(2024, 6, 15, 10, 0, 0, 0, time.UTC)
	row := cache.ClientRow{
		ID:           42,
		Server:       "sl-0",
		IsActive:     true,
		CreatedAt:    &ts,
		UpdatedAt:    nil, // explicitly null
		DataLoadedAt: &ts,
	}
	_ = db.ReplaceClients([]cache.ClientRow{row})

	r, ok := db.GetClient(42)
	if !ok {
		t.Fatal("GetClient: expected ok=true")
	}
	if r.CreatedAt == nil {
		t.Error("CreatedAt: expected non-nil")
	}
	if r.UpdatedAt != nil {
		t.Errorf("UpdatedAt: expected nil, got %v", r.UpdatedAt)
	}
	if r.DataLoadedAt == nil {
		t.Error("DataLoadedAt: expected non-nil")
	}
}
