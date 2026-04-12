package cmd

import (
	"context"
	"fmt"
	"time"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/config"
	"mpu/internal/defaults"
	"mpu/internal/pgclient"
	"mpu/internal/slapi"

	"github.com/spf13/cobra"
)

var updateSpreadsheetsCmd = &cobra.Command{
	Use:     "update-spreadsheets",
	GroupID: groupSL,
	Short:   "Fetch spreadsheets from all servers and sync to local cache",
	Long: `Queries SELECT * FROM public.spreadsheets on every active server and
caches the results in the local SQLite database.

Uses a versioned update strategy:
  1. New data is written with an incremented version number
  2. Old data is deleted only after ALL servers succeed
  3. If any server fails, new data is rolled back

Requires PG_MY_USER_NAME and PG_MY_USER_PASSWORD in .env.
Server list comes from cached clients (run 'mpu clients' first if empty).`,
	RunE: runUpdateSpreadsheets,
}

func init() {
	rootCmd.AddCommand(updateSpreadsheetsCmd)
}

func runUpdateSpreadsheets(cmd *cobra.Command, args []string) error {
	if currentConfig.ForceCache == defaults.CacheModeUse {
		return fmt.Errorf("forceCache=use: update-spreadsheets requires network access to PostgreSQL servers")
	}

	db, err := cache.Open()
	if err != nil {
		return err
	}
	defer db.Close()

	// Ensure clients are cached.
	if !db.HasClients() {
		fmt.Println("no cached clients, syncing from API...")
		token, err := auth.GetToken(db)
		if err != nil {
			return err
		}
		rows, err := slapi.GetClients(token)
		if err != nil {
			return err
		}
		if err := db.ReplaceClients(rows); err != nil {
			return fmt.Errorf("store clients: %w", err)
		}
	}

	servers, err := db.ActiveServers()
	if err != nil {
		return fmt.Errorf("list servers: %w", err)
	}
	if len(servers) == 0 {
		return fmt.Errorf("no active servers found; run 'mpu clients' first")
	}

	cfg, err := config.LoadPG()
	if err != nil {
		return err
	}
	if cfg.MyUserName == "" || cfg.MyUserPassword == "" {
		return fmt.Errorf("PG_MY_USER_NAME and PG_MY_USER_PASSWORD are required")
	}

	newVer, err := db.NextSpreadsheetVersion()
	if err != nil {
		return fmt.Errorf("get next version: %w", err)
	}

	totalCount := 0

	for _, server := range servers {
		host, err := resolveRemoteHost(server)
		if err != nil {
			db.RollbackSpreadsheetVersion(newVer) //nolint:errcheck
			return fmt.Errorf("server %s: %w", server, err)
		}

		count, err := fetchAndCacheSpreadsheets(db, cfg, host, server, newVer)
		if err != nil {
			db.RollbackSpreadsheetVersion(newVer) //nolint:errcheck
			return fmt.Errorf("server %s: %w", server, err)
		}
		totalCount += count
		fmt.Printf("  %s: %d spreadsheets\n", server, count)
	}

	if err := db.CommitSpreadsheetVersion(newVer); err != nil {
		return fmt.Errorf("commit version: %w", err)
	}

	fmt.Printf("synced %d spreadsheets from %d servers\n", totalCount, len(servers))
	return nil
}

func fetchAndCacheSpreadsheets(db *cache.DB, cfg *config.PGConfig, host, server string, version int64) (int, error) {
	ctx := context.Background()
	conn, err := pgclient.NewConn(ctx, host, cfg.RemotePort, cfg.MyUserName, cfg.MyUserPassword, cfg.DBName)
	if err != nil {
		return 0, err
	}
	defer conn.Close(ctx)

	rows, err := pgclient.QueryJSON(ctx, conn, "SELECT * FROM public.spreadsheets")
	if err != nil {
		return 0, err
	}

	// Convert and insert in chunks.
	chunk := make([]cache.SpreadsheetRow, 0, cache.ChunkSize)
	total := 0

	for _, row := range rows {
		sr := mapToSpreadsheetRow(row, server, version)
		chunk = append(chunk, sr)

		if len(chunk) >= cache.ChunkSize {
			if err := db.InsertSpreadsheetChunk(chunk); err != nil {
				return 0, err
			}
			total += len(chunk)
			chunk = chunk[:0]
		}
	}

	// Insert remaining rows.
	if len(chunk) > 0 {
		if err := db.InsertSpreadsheetChunk(chunk); err != nil {
			return 0, err
		}
		total += len(chunk)
	}

	return total, nil
}

func mapToSpreadsheetRow(m map[string]any, server string, version int64) cache.SpreadsheetRow {
	r := cache.SpreadsheetRow{
		Server:  server,
		Version: version,
	}

	if v, ok := m["client_id"]; ok {
		r.ClientID = toInt64(v)
	}
	if v, ok := m["spreadsheet_id"].(string); ok {
		r.SpreadsheetID = v
	}
	if v, ok := m["title"].(string); ok {
		r.Title = v
	}
	if v, ok := m["template_name"].(string); ok {
		r.TemplateName = v
	}
	if v, ok := m["script_id"].(string); ok {
		r.ScriptID = v
	}
	if v, ok := m["is_active"].(bool); ok {
		r.IsActive = v
	}
	r.CreatedAt = toTimePtr(m["created_at"])
	r.UpdatedAt = toTimePtr(m["updated_at"])
	r.SubscriptionExpiresAt = toTimePtr(m["subscription_expires_at"])

	return r
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case float64:
		return int64(n)
	default:
		return 0
	}
}

func toTimePtr(v any) *time.Time {
	if v == nil {
		return nil
	}
	switch t := v.(type) {
	case time.Time:
		return &t
	case string:
		for _, layout := range []string{time.RFC3339, time.DateTime, "2006-01-02T15:04:05.999Z07:00"} {
			if parsed, err := time.Parse(layout, t); err == nil {
				return &parsed
			}
		}
	}
	return nil
}
