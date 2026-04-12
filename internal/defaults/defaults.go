package defaults

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Values holds last-used flag values keyed by flag name.
type Values map[string]any

// CacheMode controls caching behavior.
//
// Symbolic modes:
//
//	""             cache-aside: read cache, refresh from API on miss
//	"accumulate"   merge new rows into cache, keep the old ones
//	"use"          read only from cache, never hit the network
//
// Numeric modes: a positive integer string (e.g. "300") is interpreted as
// a TTL in seconds — cache entries are considered fresh only within that
// window. The token cache is an exception: it always uses its built-in
// 10-minute TTL regardless of this setting (except in "use" mode, where
// the network is never touched at all).
type CacheMode string

const (
	CacheModeNone       CacheMode = ""
	CacheModeAccumulate CacheMode = "accumulate"
	CacheModeUse        CacheMode = "use"
)

// CacheTTL returns the numeric TTL interpretation of ForceCache. Returns
// (0, false) for the symbolic modes and for any non-positive-integer
// string, so callers can use the boolean to branch.
func (c Config) CacheTTL() (time.Duration, bool) {
	s := string(c.ForceCache)
	if s == "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, false
	}
	return time.Duration(n) * time.Second, true
}

// Config is the top-level structure of ~/.config/mpu/config.json.
// Settings exposed to the user (Protected, ForceCache, RemotePostgresOnly)
// are serialized unconditionally so every knob appears in the file even at
// its zero value — users can edit without having to recall the field names.
// Command is runtime state for smart-repeat, not a user setting, so it stays
// omitempty.
type Config struct {
	Protected          bool      `json:"protected"`
	ForceCache         CacheMode `json:"forceCache"`
	RemotePostgresOnly bool      `json:"remotePostgresOnly"`
	Command            string    `json:"command,omitempty"` // last-used command group, e.g. "webApp"
	Defaults           Values    `json:"defaults"`
}

func filePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "mpu", "config.json"), nil
}

// FilePath returns the config file path for use in error messages.
func FilePath() string {
	p, _ := filePath()
	return p
}

// Load reads config from disk. Returns a zero Config (protected=false, empty
// defaults) when the file is missing or contains invalid JSON.
func Load() (Config, error) {
	path, err := filePath()
	if err != nil {
		return newConfig(), err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return newConfig(), nil
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return newConfig(), nil
	}
	if c.Defaults == nil {
		c.Defaults = make(Values)
	}
	return c, nil
}

// Save writes config to disk, creating the directory if needed.
func Save(c Config) error {
	path, err := filePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func newConfig() Config {
	return Config{Protected: true, Defaults: make(Values)}
}
