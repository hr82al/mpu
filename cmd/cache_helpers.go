package cmd

import (
	"fmt"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/defaults"
	"mpu/internal/slapi"
)

// getAuthToken returns auth token, respecting forceCache mode.
// In use mode, returns stale token from cache.
// In accumulate/none mode, fetches fresh token and caches it.
func getAuthToken(db *cache.DB) (string, error) {
	if currentConfig.ForceCache == defaults.CacheModeUse {
		return auth.GetTokenForced(db)
	}
	return auth.GetToken(db)
}

// syncClientsFromAPI syncs clients from sl-back API, respecting forceCache mode.
// In use mode, returns error (network unavailable).
// In accumulate/none mode, fetches and caches client list.
func syncClientsFromAPI(db *cache.DB) error {
	if currentConfig.ForceCache == defaults.CacheModeUse {
		return fmt.Errorf("network unavailable (forceCache=use): run 'mpu clients' without forceCache=use first to populate cache")
	}

	token, err := auth.GetToken(db)
	if err != nil {
		return err
	}

	rows, err := slapi.GetClients(token)
	if err != nil {
		return err
	}

	return db.ReplaceClients(rows)
}
