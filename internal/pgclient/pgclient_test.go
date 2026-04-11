package pgclient_test

import (
	"context"
	"testing"

	"mpu/internal/pgclient"
)

// TestNewConn_InvalidCredentials tests connection failure with bad credentials.
func TestNewConn_InvalidCredentials(t *testing.T) {
	ctx := context.Background()
	_, err := pgclient.NewConn(ctx, "localhost", "9999", "nonexistent", "badpass", "nodb")
	if err == nil {
		t.Fatal("expected error on invalid credentials, got nil")
	}
}

// TestQueryJSON_EmptyResult tests querying a valid table with no rows.
// This test requires a running PostgreSQL instance, so it's skipped by default.
func TestQueryJSON_EmptyResult(t *testing.T) {
	t.Skip("requires running PostgreSQL instance")
}

// TestQueryJSON_ValidQuery tests executing a valid query and getting results.
// This test requires a running PostgreSQL instance, so it's skipped by default.
func TestQueryJSON_ValidQuery(t *testing.T) {
	t.Skip("requires running PostgreSQL instance")
}
