package cache_test

import (
	"fmt"
	"testing"

	"mpu/internal/cache"
)

func TestSpreadsheets_InsertChunkAndQuery(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	rows := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "ss1", Title: "Alpha Sheet", TemplateName: "tmpl1", IsActive: true, Version: 1},
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "ss2", Title: "Beta Sheet", TemplateName: "tmpl2", IsActive: false, Version: 1},
		{Server: "sl-2", ClientID: 20, SpreadsheetID: "ss3", Title: "Gamma Sheet", TemplateName: "tmpl3", IsActive: true, Version: 1},
	}

	if err := db.InsertSpreadsheetChunk(rows); err != nil {
		t.Fatalf("InsertSpreadsheetChunk: %v", err)
	}

	// Query by client ID.
	got, err := db.SpreadsheetsByClientID(10)
	if err != nil {
		t.Fatalf("SpreadsheetsByClientID: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 rows for client 10, got %d", len(got))
	}

	// Query by client ID with no results.
	got, err = db.SpreadsheetsByClientID(999)
	if err != nil {
		t.Fatalf("SpreadsheetsByClientID(999): %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 rows for client 999, got %d", len(got))
	}
}

func TestSpreadsheets_SearchByTitle(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	rows := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "ss1", Title: "Cool Flaps Main", Version: 1},
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "ss2", Title: "Warm Shoes Test", Version: 1},
		{Server: "sl-2", ClientID: 20, SpreadsheetID: "ss3", Title: "Cool Flaps Backup", Version: 1},
	}
	if err := db.InsertSpreadsheetChunk(rows); err != nil {
		t.Fatalf("InsertSpreadsheetChunk: %v", err)
	}

	got, err := db.SearchSpreadsheets("cool", 50)
	if err != nil {
		t.Fatalf("SearchSpreadsheets: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 matches for 'cool', got %d", len(got))
	}

	got, err = db.SearchSpreadsheets("nonexistent", 50)
	if err != nil {
		t.Fatalf("SearchSpreadsheets: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 matches for 'nonexistent', got %d", len(got))
	}
}

func TestSpreadsheets_HasSpreadsheets(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	if db.HasSpreadsheets() {
		t.Fatal("expected no spreadsheets initially")
	}

	rows := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 1, SpreadsheetID: "ss1", Title: "Test", Version: 1},
	}
	if err := db.InsertSpreadsheetChunk(rows); err != nil {
		t.Fatalf("InsertSpreadsheetChunk: %v", err)
	}

	if !db.HasSpreadsheets() {
		t.Fatal("expected HasSpreadsheets=true after insert")
	}
}

func TestSpreadsheets_VersionCommit(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// Insert version 1 data.
	v1 := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "old1", Title: "Old Sheet", Version: 1},
	}
	if err := db.InsertSpreadsheetChunk(v1); err != nil {
		t.Fatalf("insert v1: %v", err)
	}

	// Insert version 2 data.
	v2 := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "new1", Title: "New Sheet", Version: 2},
		{Server: "sl-2", ClientID: 20, SpreadsheetID: "new2", Title: "Another New", Version: 2},
	}
	if err := db.InsertSpreadsheetChunk(v2); err != nil {
		t.Fatalf("insert v2: %v", err)
	}

	// Before commit: queries return version 2 (max version).
	got, err := db.SpreadsheetsByClientID(10)
	if err != nil {
		t.Fatalf("query before commit: %v", err)
	}
	if len(got) != 1 || got[0].SpreadsheetID != "new1" {
		t.Fatalf("expected new1 (max version), got %v", got)
	}

	// Commit version 2: removes version 1 data.
	if err := db.CommitSpreadsheetVersion(2); err != nil {
		t.Fatalf("commit: %v", err)
	}

	all, err := db.AllSpreadsheets()
	if err != nil {
		t.Fatalf("AllSpreadsheets: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 rows after commit, got %d", len(all))
	}
}

func TestSpreadsheets_VersionRollback(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// Insert version 1 data.
	v1 := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "old1", Title: "Old Sheet", Version: 1},
	}
	if err := db.InsertSpreadsheetChunk(v1); err != nil {
		t.Fatalf("insert v1: %v", err)
	}

	// Insert partial version 2 data.
	v2 := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 10, SpreadsheetID: "new1", Title: "New Sheet", Version: 2},
	}
	if err := db.InsertSpreadsheetChunk(v2); err != nil {
		t.Fatalf("insert v2: %v", err)
	}

	// Rollback version 2.
	if err := db.RollbackSpreadsheetVersion(2); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	// Only version 1 data remains.
	all, err := db.AllSpreadsheets()
	if err != nil {
		t.Fatalf("AllSpreadsheets: %v", err)
	}
	if len(all) != 1 || all[0].SpreadsheetID != "old1" {
		t.Fatalf("expected old1 after rollback, got %v", all)
	}
}

func TestSpreadsheets_NextVersion(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	v, err := db.NextSpreadsheetVersion()
	if err != nil {
		t.Fatalf("NextSpreadsheetVersion: %v", err)
	}
	if v != 1 {
		t.Fatalf("expected version 1 on empty table, got %d", v)
	}

	rows := []cache.SpreadsheetRow{
		{Server: "sl-1", ClientID: 1, SpreadsheetID: "ss1", Title: "Test", Version: 5},
	}
	if err := db.InsertSpreadsheetChunk(rows); err != nil {
		t.Fatalf("InsertSpreadsheetChunk: %v", err)
	}

	v, err = db.NextSpreadsheetVersion()
	if err != nil {
		t.Fatalf("NextSpreadsheetVersion: %v", err)
	}
	if v != 6 {
		t.Fatalf("expected version 6 after inserting v5, got %d", v)
	}
}

func TestSpreadsheets_ChunkedInsert(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// Insert more than ChunkSize rows to verify chunking works.
	rows := make([]cache.SpreadsheetRow, cache.ChunkSize+100)
	for i := range rows {
		rows[i] = cache.SpreadsheetRow{
			Server:        "sl-1",
			ClientID:      int64(i % 10),
			SpreadsheetID: fmt.Sprintf("ss_%d", i),
			Title:         fmt.Sprintf("Sheet %d", i),
			Version:       1,
		}
	}

	// Insert in two chunks to simulate real usage.
	chunk1 := rows[:cache.ChunkSize]
	chunk2 := rows[cache.ChunkSize:]

	if err := db.InsertSpreadsheetChunk(chunk1); err != nil {
		t.Fatalf("chunk1: %v", err)
	}
	if err := db.InsertSpreadsheetChunk(chunk2); err != nil {
		t.Fatalf("chunk2: %v", err)
	}

	all, err := db.AllSpreadsheets()
	if err != nil {
		t.Fatalf("AllSpreadsheets: %v", err)
	}
	if len(all) != cache.ChunkSize+100 {
		t.Fatalf("expected %d rows, got %d", cache.ChunkSize+100, len(all))
	}
}

func TestSpreadsheets_ActiveServers(t *testing.T) {
	withTempHome(t)
	db := openDB(t)

	// No clients → no servers.
	servers, err := db.ActiveServers()
	if err != nil {
		t.Fatalf("ActiveServers: %v", err)
	}
	if len(servers) != 0 {
		t.Fatalf("expected 0 servers, got %d", len(servers))
	}

	// Add clients with different servers.
	clients := []cache.ClientRow{
		{ID: 1, Server: "sl-1", IsActive: true},
		{ID: 2, Server: "sl-1", IsActive: true},
		{ID: 3, Server: "sl-2", IsActive: true},
		{ID: 4, Server: "sl-3", IsActive: false}, // inactive
		{ID: 5, Server: "", IsActive: true},       // empty server
	}
	if err := db.ReplaceClients(clients); err != nil {
		t.Fatalf("ReplaceClients: %v", err)
	}

	servers, err = db.ActiveServers()
	if err != nil {
		t.Fatalf("ActiveServers: %v", err)
	}
	if len(servers) != 2 {
		t.Fatalf("expected 2 servers (sl-1, sl-2), got %v", servers)
	}
	if servers[0] != "sl-1" || servers[1] != "sl-2" {
		t.Fatalf("expected [sl-1 sl-2], got %v", servers)
	}
}
