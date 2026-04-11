package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"mpu/internal/auth"
	"mpu/internal/cache"
	"mpu/internal/slapi"

	"github.com/spf13/cobra"
)

var clientCmd = &cobra.Command{
	Use:     "client [id]",
	GroupID: groupSL,
	Short:   "Get a single client by ID (local cache first, then API)",
	Long: `Looks up a client by ID in the local cache (~/.config/mpu/db).
If not found, fetches the full client list from sl-back, syncs to cache,
then returns the requested client.

The ID argument is optional after the first use — it is saved to defaults
and reused on subsequent calls:

  mpu client 42              # fetches client 42, saves id=42
  mpu client                 # reuses saved id=42
  mpu                        # repeats last command with saved id and fields

--fields controls which fields to return (also persisted in defaults):
  - not set / empty  → full JSON object
  - single field     → raw value (no JSON wrapper)
  - multiple fields  → JSON object with only those fields

  mpu client 42 --fields server          # sl-1
  mpu client 42 --fields id,server       # {"id":42,"server":"sl-1"}
  mpu client 42 --fields ""              # clears saved fields → full JSON`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id, err := resolveClientID(args)
		if err != nil {
			return err
		}

		db, err := cache.Open()
		if err != nil {
			return err
		}
		defer db.Close()

		// Try cache first.
		client, ok := db.GetClient(id)
		if !ok {
			// Not in cache → sync from API then retry.
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
			client, ok = db.GetClient(id)
			if !ok {
				return fmt.Errorf("client %d not found", id)
			}
		}

		fields := getFieldsFlag(cmd)
		return printClientFields(client, fields)
	},
}

// resolveClientID returns the client ID from args[0] or from saved defaults.
// Saves the ID to defaults when provided explicitly.
func resolveClientID(args []string) (int64, error) {
	const key = "client-id"

	if len(args) > 0 {
		id, err := strconv.ParseInt(args[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid id %q: %w", args[0], err)
		}
		currentConfig.Defaults[key] = float64(id)
		return id, nil
	}

	// No arg — try saved default.
	v, ok := currentConfig.Defaults[key]
	if !ok {
		return 0, fmt.Errorf("client id is required: provide it as an argument or run 'mpu client <id>' first")
	}
	fval, ok := v.(float64) // JSON numbers deserialise as float64.
	if !ok || fval <= 0 {
		return 0, fmt.Errorf("invalid saved client-id; run 'mpu client <id>' to set it")
	}
	return int64(fval), nil
}

var clientFields = []string{
	"id", "server", "is_active", "is_locked", "is_deleted",
	"created_at", "updated_at", "data_loaded_at", "synced_at",
}

func init() {
	clientCmd.Flags().String("fields", "", "comma-separated fields to return (empty = all)")

	// Shell completion: suggest known field names for --fields.
	_ = clientCmd.RegisterFlagCompletionFunc("fields", func(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		return clientFields, cobra.ShellCompDirectiveNoFileComp
	})

	// Shell completion: suggest client IDs from the local cache.
	clientCmd.ValidArgsFunction = func(_ *cobra.Command, args []string, _ string) ([]string, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		db, err := cache.Open()
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		defer db.Close()
		ids, err := db.ListClientIDs()
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return ids, cobra.ShellCompDirectiveNoFileComp
	}

	rootCmd.AddCommand(clientCmd)
}

// getFieldsFlag reads --fields, persists it to defaults, returns split list.
// Returns nil when fields is unset / empty (meaning: return all).
func getFieldsFlag(cmd *cobra.Command) []string {
	const name = "fields"

	if cmd.Flags().Changed(name) {
		val, _ := cmd.Flags().GetString(name)
		currentConfig.Defaults[name] = val // persist even empty (resets to "all")
		return splitFields(val)
	}

	if v, ok := currentConfig.Defaults[name]; ok {
		if s, ok := v.(string); ok && s != "" {
			return splitFields(s)
		}
	}
	return nil
}

func splitFields(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func printClientFields(client *cache.ClientRow, fields []string) error {
	raw, err := json.Marshal(client)
	if err != nil {
		return err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}

	switch len(fields) {
	case 0:
		printJSON(client)
	case 1:
		v, ok := m[fields[0]]
		if !ok {
			return fmt.Errorf("unknown field %q", fields[0])
		}
		fmt.Println(formatValue(v))
	default:
		subset := make(map[string]any, len(fields))
		for _, f := range fields {
			v, ok := m[f]
			if !ok {
				return fmt.Errorf("unknown field %q", f)
			}
			subset[f] = v
		}
		printJSON(subset)
	}
	return nil
}

func formatValue(v any) string {
	switch val := v.(type) {
	case string:
		return val
	case nil:
		return "null"
	default:
		b, _ := json.Marshal(val)
		return string(b)
	}
}
