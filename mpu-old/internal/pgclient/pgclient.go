package pgclient

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// NewConn opens a PostgreSQL connection with the given credentials.
func NewConn(ctx context.Context, host, port, user, password, dbName string) (*pgx.Conn, error) {
	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, dbName)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect to %s:%s as %s: %w", host, port, user, err)
	}
	return conn, nil
}

// QueryJSON runs sql and returns results as a slice of row maps.
// Column names come from the server's field descriptions.
func QueryJSON(ctx context.Context, conn *pgx.Conn, sql string) ([]map[string]any, error) {
	rows, err := conn.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	var result []map[string]any

	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make(map[string]any, len(fields))
		for i, f := range fields {
			row[string(f.Name)] = vals[i]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
