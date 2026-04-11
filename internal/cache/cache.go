package cache

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// DB wraps sql.DB and exposes cache operations.
type DB struct {
	*sql.DB
}

// Open opens (or creates) the SQLite database at ~/.config/mpu/db and runs
// all pending migrations. Caller is responsible for calling Close().
func Open() (*DB, error) {
	path, err := dbPath()
	if err != nil {
		return nil, fmt.Errorf("cache path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, fmt.Errorf("create cache dir: %w", err)
	}
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open cache db: %w", err)
	}
	db := &DB{sqlDB}
	if err := db.migrate(allMigrations); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

func dbPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "mpu", "db"), nil
}
