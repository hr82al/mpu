// Package slapi provides a typed HTTP client for the sl-back REST API.
package slapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"mpu/internal/cache"
	"mpu/internal/config"
)

// GetClients fetches the full client list from GET /api/admin/client.
// Results are returned as cache.ClientRow slices, ready to be stored.
func GetClients(token string) ([]cache.ClientRow, error) {
	cfg, err := config.LoadAuth()
	if err != nil {
		return nil, err
	}

	url := strings.TrimRight(cfg.APIURL, "/") + "/admin/client"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, data)
	}

	var items []apiClientItem
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	rows := make([]cache.ClientRow, len(items))
	for i, it := range items {
		rows[i] = it.toRow()
	}
	return rows, nil
}

// apiClientItem mirrors the JSON shape returned by sl-back.
type apiClientItem struct {
	ID           int64      `json:"id"`
	Server       string     `json:"server"`
	IsActive     bool       `json:"is_active"`
	IsLocked     bool       `json:"is_locked"`
	IsDeleted    bool       `json:"is_deleted"`
	CreatedAt    *time.Time `json:"created_at"`
	UpdatedAt    *time.Time `json:"updated_at"`
	DataLoadedAt *time.Time `json:"data_loaded_at"`
}

func (a apiClientItem) toRow() cache.ClientRow {
	return cache.ClientRow{
		ID:           a.ID,
		Server:       a.Server,
		IsActive:     a.IsActive,
		IsLocked:     a.IsLocked,
		IsDeleted:    a.IsDeleted,
		CreatedAt:    a.CreatedAt,
		UpdatedAt:    a.UpdatedAt,
		DataLoadedAt: a.DataLoadedAt,
	}
}
