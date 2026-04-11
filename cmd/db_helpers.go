package cmd

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"mpu/internal/config"
	"mpu/internal/pgclient"
)

// resolveDBArgs parses positional args for ldb/rdb commands:
//
//	1 arg  → SQL only; client-id loaded from defaults
//	2 args → args[0] is client-id (saved to defaults), args[1] is SQL
func resolveDBArgs(args []string) (id int64, sql string, err error) {
	if len(args) == 2 {
		id, err = strconv.ParseInt(args[0], 10, 64)
		if err != nil {
			return 0, "", fmt.Errorf("invalid id %q: %w", args[0], err)
		}
		currentConfig.Defaults["client-id"] = float64(id)
		sql = args[1]
		return id, sql, nil
	}

	// 1 arg: SQL only, load id from defaults.
	sql = args[0]
	v, ok := currentConfig.Defaults["client-id"]
	if !ok {
		return 0, "", fmt.Errorf("client-id is required: run 'mpu ldb <id> <sql>' first")
	}
	fval, ok := v.(float64)
	if !ok || fval <= 0 {
		return 0, "", fmt.Errorf("invalid saved client-id; run 'mpu ldb <id> <sql>' to set it")
	}
	return int64(fval), sql, nil
}

// runQuery connects to PostgreSQL at host:port as the given user and runs sql.
func runQuery(cfg *config.PGConfig, host, port, user, sql string) error {
	return runQueryWithCreds(cfg.DBName, host, port, user, cfg.ClientPassword, "", sql)
}

// runQueryWithCreds connects to PostgreSQL with explicit credentials.
// If searchPath is non-empty, SET search_path is executed before the main query.
func runQueryWithCreds(dbName, host, port, user, password, searchPath, sql string) error {
	ctx := context.Background()
	conn, err := pgclient.NewConn(ctx, host, port, user, password, dbName)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	if searchPath != "" {
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET search_path TO %s", searchPath)); err != nil {
			return fmt.Errorf("set search_path: %w", err)
		}
	}

	rows, err := pgclient.QueryJSON(ctx, conn, sql)
	if err != nil {
		return err
	}
	printJSON(rows)
	return nil
}

// resolveHost tries to resolve name via .env, falls back to using it as direct address.
func resolveHost(name string) string {
	if resolved, err := resolveRemoteHost(name); err == nil {
		return resolved
	}
	return name
}

// resolveRemoteHost looks up the host address for a server name.
// Server name uses dashes (e.g. "sl-1"), env vars use underscores (e.g. "sl_1").
// Tries exact env var name first (lowercase), then uppercase.
func resolveRemoteHost(server string) (string, error) {
	// Convert dashes to underscores for env var lookup
	envKey := strings.ReplaceAll(server, "-", "_")

	// Try exact case first
	if h := os.Getenv(envKey); h != "" {
		return h, nil
	}

	// Try uppercase
	if h := os.Getenv(strings.ToUpper(envKey)); h != "" {
		return h, nil
	}

	return "", fmt.Errorf(
		"host for server %q not found in .env\nplease add: %s=<host address>",
		server, envKey,
	)
}
