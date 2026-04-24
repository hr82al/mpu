// Package auth provides a reusable token getter backed by the SQLite cache.
package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"mpu/internal/cache"
	"mpu/internal/config"
)

const cacheKey = "sl_access_token"
const maxAge = 10 * time.Minute

// GetToken returns a valid sl-back access token.
// It checks the cache first; if the cached token is older than 10 minutes
// (or absent), it fetches a new one and updates the cache.
func GetToken(db *cache.DB) (string, error) {
	if tok, ok := db.GetToken(cacheKey, maxAge); ok {
		return tok, nil
	}
	cfg, err := config.LoadAuth()
	if err != nil {
		return "", err
	}
	tok, err := fetchToken(cfg)
	if err != nil {
		return "", err
	}
	_ = db.SetToken(cacheKey, tok)
	return tok, nil
}

// GetTokenForced returns token from cache without TTL check.
// Used in forceCache=use mode when network is unavailable.
// Returns error if no cached token exists.
func GetTokenForced(db *cache.DB) (string, error) {
	var token string
	err := db.QueryRow(`SELECT token FROM token_cache WHERE key = ?`, cacheKey).Scan(&token)
	if err != nil || token == "" {
		return "", fmt.Errorf("no cached token (run 'mpu token' without forceCache=use first)")
	}
	return token, nil
}

func fetchToken(cfg *config.AuthConfig) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"email":    cfg.Email,
		"password": cfg.Password,
	})
	url := strings.TrimRight(cfg.APIURL, "/") + "/auth/login"
	resp, err := http.Post(url, "application/json", bytes.NewReader(body)) //nolint:noctx
	if err != nil {
		return "", fmt.Errorf("login request: %w", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("login failed (HTTP %d): %s", resp.StatusCode, data)
	}
	var result struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}
	if result.AccessToken == "" {
		return "", fmt.Errorf("empty token in response: %s", data)
	}
	return result.AccessToken, nil
}
