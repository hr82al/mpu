package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mpu/internal/cache"
	"mpu/internal/defaults"
)

// setupTTLEnv wires a temp HOME, a fake sl-back HTTP server, and the .env
// pointing at it. Returns the cache DB and a counter tracking API hits.
func setupTTLEnv(t *testing.T) (*cache.DB, *int32) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Fake API: /auth/login returns a token; /admin/client returns an
	// empty list. Counter increments on every hit so tests can assert
	// whether the cache was bypassed.
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		switch {
		case strings.HasSuffix(r.URL.Path, "/auth/login"):
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"accessToken":"tok-%d"}`, atomic.LoadInt32(&hits))
		case strings.Contains(r.URL.Path, "/admin/client"):
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[{"id":42,"server":"sl-1","is_active":true,"is_locked":false,"is_deleted":false}]`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)

	// Use t.Setenv so each test gets its own fresh URL regardless of a
	// stale .env loaded into the process during earlier tests. godotenv
	// never overrides existing env, so writing a new .env per-test
	// wouldn't propagate.
	envDir := filepath.Join(home, ".config", "mpu")
	os.MkdirAll(envDir, 0700)
	t.Setenv("NEXT_PUBLIC_SERVER_URL", srv.URL)
	t.Setenv("BASE_API_URL", "/api")
	t.Setenv("TOKEN_EMAIL", "a@b")
	t.Setenv("TOKEN_PASSWORD", "x")

	db, err := cache.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	currentConfig = defaults.Config{Defaults: make(defaults.Values)}
	return db, &hits
}

// ── Client-cache TTL ────────────────────────────────────────────────────

// Fresh cache + numeric TTL → no API call.
func TestClientCacheFreshWithinTTL(t *testing.T) {
	db, hits := setupTTLEnv(t)

	// Seed a fresh client (synced_at = now by default).
	db.ReplaceClients([]cache.ClientRow{{ID: 42, Server: "sl-1", IsActive: true}})
	before := atomic.LoadInt32(hits)

	currentConfig.ForceCache = "3600" // 1-hour TTL
	if err := syncClientsFromAPI(db); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if atomic.LoadInt32(hits) != before {
		t.Errorf("fresh cache within TTL should not hit API")
	}
}

// Stale cache + numeric TTL → API call, cache refreshed.
func TestClientCacheStaleBeyondTTL(t *testing.T) {
	db, hits := setupTTLEnv(t)
	db.ReplaceClients([]cache.ClientRow{{ID: 42, Server: "sl-1", IsActive: true}})

	// Back-date synced_at an hour into the past.
	_, err := db.Exec(
		`UPDATE sl_clients SET synced_at = ? WHERE id = ?`,
		time.Now().Add(-time.Hour).UTC().Format(time.DateTime),
		42,
	)
	if err != nil {
		t.Fatal(err)
	}
	before := atomic.LoadInt32(hits)

	currentConfig.ForceCache = "60" // 1-minute TTL — our row is 60× older
	if err := syncClientsFromAPI(db); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if atomic.LoadInt32(hits) <= before {
		t.Errorf("stale cache beyond TTL must hit API (hits before=%d, after=%d)",
			before, atomic.LoadInt32(hits))
	}
}

// Default mode (no TTL) → existing behaviour preserved: syncClientsFromAPI
// always hits the network.
func TestClientCacheDefaultModeAlwaysHitsAPI(t *testing.T) {
	db, hits := setupTTLEnv(t)
	db.ReplaceClients([]cache.ClientRow{{ID: 42, Server: "sl-1", IsActive: true}})
	before := atomic.LoadInt32(hits)

	currentConfig.ForceCache = defaults.CacheModeNone
	_ = syncClientsFromAPI(db)
	if atomic.LoadInt32(hits) <= before {
		t.Errorf("default mode should still reach API")
	}
}

// use mode + numeric-TTL-looking value is impossible (mutually exclusive
// strings), but stale cache in `use` mode must not try the network.
func TestUseModeNeverHitsAPI(t *testing.T) {
	db, hits := setupTTLEnv(t)
	db.ReplaceClients([]cache.ClientRow{{ID: 42}})
	before := atomic.LoadInt32(hits)

	currentConfig.ForceCache = defaults.CacheModeUse
	_ = syncClientsFromAPI(db)
	if atomic.LoadInt32(hits) != before {
		t.Errorf("use mode must not hit API")
	}
}

// ── Token: always 10-min TTL regardless of numeric forceCache ───────────

// Token's own 10-minute TTL is independent of the numeric forceCache
// setting. A 10s numeric TTL must NOT shorten the token's freshness window.
func TestTokenTTLIsAlwaysTenMinutes(t *testing.T) {
	db, hits := setupTTLEnv(t)

	// Seed a fresh token via the normal path.
	currentConfig.ForceCache = defaults.CacheModeNone
	if _, err := getAuthToken(db); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	afterSeed := atomic.LoadInt32(hits)

	// Even with a very short numeric TTL (1 second), getAuthToken must
	// respect the token's fixed 10-min TTL and NOT refetch.
	currentConfig.ForceCache = "1"
	time.Sleep(50 * time.Millisecond)
	if _, err := getAuthToken(db); err != nil {
		t.Fatalf("get token again: %v", err)
	}
	if atomic.LoadInt32(hits) != afterSeed {
		t.Errorf("numeric forceCache must not shorten token TTL (hits seed=%d now=%d)",
			afterSeed, atomic.LoadInt32(hits))
	}
}

// Token in `use` mode: never hit the network even if cache is empty
// (returns error) — confirms the `use` exception from the spec.
func TestTokenUseModeNeverNetwork(t *testing.T) {
	db, hits := setupTTLEnv(t)
	before := atomic.LoadInt32(hits)

	currentConfig.ForceCache = defaults.CacheModeUse
	if _, err := getAuthToken(db); err == nil {
		t.Error("expected error from empty token cache in use mode")
	}
	if atomic.LoadInt32(hits) != before {
		t.Errorf("use mode token fetch must not touch network")
	}
}

// ── config command integration ──────────────────────────────────────────

// Numeric seconds are a valid forceCache value and persist to disk.
func TestConfigForceCacheAcceptsNumeric(t *testing.T) {
	home, _ := setupTest(t)

	rootCmd.SetArgs([]string{"config", "forceCache", "300"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("set: %v", err)
	}
	cfg := readConfig(t, home)
	if cfg.ForceCache != "300" {
		t.Errorf("persisted forceCache = %q, want %q", cfg.ForceCache, "300")
	}

	d, ok := cfg.CacheTTL()
	if !ok || d != 5*time.Minute {
		t.Errorf("CacheTTL after set = %v/%v, want 5m", d, ok)
	}
}

// Negative numbers & garbage are still rejected by the config setter — the
// three symbolic modes plus a positive integer string is the full contract.
func TestConfigForceCacheRejectsBadNumerics(t *testing.T) {
	setupTest(t)

	for _, v := range []string{"-5", "0", "3.14", "abc"} {
		rootCmd.SetArgs([]string{"config", "forceCache", v})
		if err := rootCmd.Execute(); err == nil {
			t.Errorf("expected error for forceCache=%q", v)
		}
	}
}

// Serialization round-trip through JSON.
func TestConfigForceCacheJSONRoundTrip(t *testing.T) {
	c := defaults.Config{ForceCache: "600"}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"forceCache":"600"`) {
		t.Errorf("expected numeric forceCache in JSON, got %s", data)
	}
	var round defaults.Config
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	if round.ForceCache != "600" {
		t.Errorf("round-tripped ForceCache = %q, want %q", round.ForceCache, "600")
	}
}
