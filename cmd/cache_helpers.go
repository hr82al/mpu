package cmd

import (
	"fmt"
	"time"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/defaults"
	"mpu/internal/slapi"
)

// getAuthToken returns auth token, respecting forceCache mode.
//
// Special rules for the token cache:
//   - The token's own 10-minute TTL (see internal/auth.GetToken) is the
//     authoritative window. Numeric forceCache values do NOT override it.
//   - forceCache=use never touches the network, even if no cached token
//     exists (returns an error instead).
func getAuthToken(db *cache.DB) (string, error) {
	if currentConfig.ForceCache == defaults.CacheModeUse {
		return auth.GetTokenForced(db)
	}
	return auth.GetToken(db)
}

// syncClientsFromAPI refreshes the local sl_clients table from sl-back.
//
// Modes:
//   - "use"                → never hits API; errors out instead.
//   - numeric TTL seconds  → skips the fetch if every cached row's
//                            synced_at is within the TTL window.
//   - default/accumulate   → always fetches (existing behaviour).
func syncClientsFromAPI(db *cache.DB) error {
	if currentConfig.ForceCache == defaults.CacheModeUse {
		return fmt.Errorf("network unavailable (forceCache=use): run 'mpu clients' without forceCache=use first to populate cache")
	}

	// Numeric TTL: if the cache is still fresh, reuse it and skip the
	// network round-trip entirely. "Fresh" means the OLDEST synced_at
	// among cached clients is within the window; that way a partial
	// resync doesn't accidentally count as "everyone is fresh".
	if ttl, ok := currentConfig.CacheTTL(); ok {
		if oldest, hasAny := db.ClientsOldestSyncedAt(); hasAny && time.Since(oldest) < ttl {
			return nil
		}
	}

	token, err := auth.GetToken(db)
	if err != nil {
		return err
	}

	rows, err := slapi.GetClients(token)
	if err != nil {
		return err
	}

	// ReplaceClients runs in a transaction: old rows are deleted and new
	// ones inserted atomically, with synced_at stamped to `now` by the
	// column default. That is the "delete old, write with new timestamp"
	// semantics the numeric-TTL mode promises.
	return db.ReplaceClients(rows)
}
