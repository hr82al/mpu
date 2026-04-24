package cmd

import (
	"fmt"
	"strings"

	"mpu/internal/defaults"

	"github.com/spf13/cobra"
)

const (
	groupSheets = "sheets"
	groupSL     = "sl"
	groupMeta   = "meta"
	groupWebApp = "webApp" // annotation value used by PersistentPostRunE
)

var rootCmd = &cobra.Command{
	Use:   "mpu",
	Short: "Multi-purpose utility for Google Sheets and PostgreSQL",
	Long: `mpu — CLI for Google Sheets (webApp), sl-back API (token/clients/client),
and PostgreSQL client schema access (ldb/rdb).

TOP-LEVEL COMMANDS
  Google Sheets:
    get, set, insert, upsert, keys, info, batch-get, batch-update, values-update,
    delete, sharing, protection, editors, create, copy, folder

  sl-back API:
    token                Fetch and cache auth token
    clients              Fetch and sync all clients to cache
    client <id>          Get single client by ID (cache + optional API sync)

  PostgreSQL (direct schema access):
    ldb [id] <sql>       Run SQL on local schema (127.0.0.1:5441)
    rdb [id] <sql>       Run SQL on remote schema (host from .env)
    lsdb <sql>           Run SQL on local schema with explicit --scheme
    rsdb <sql>           Run SQL on remote schema with explicit --scheme and --host

SMART REPEAT
  Running 'mpu' with no arguments repeats the last command.
  Commands that require positional arguments cannot be auto-repeated.

    mpu get -s SHEET_ID -n Sheet1   # run and save flags
    mpu                             # repeats: mpu get (with saved flags)

REMEMBERED FLAGS & DEFAULTS
  Persisted in ~/.config/mpu/config.json after first use:
    -s / --spreadsheet-id   Google Sheets ID (webApp commands)
    -n / --sheet-name       Sheet tab name (webApp commands)
    --fields                Fields to return (client command)
    client-id               Client ID for ldb/rdb/client commands

  Examples:
    mpu get -s 1eJfR... -n Prices  # saves -s and -n
    mpu get                         # reuses saved flags
    mpu client 42                   # saves id=42
    mpu client                      # reuses id=42
    mpu ldb "SELECT 1"              # reuses id=42 (same key)
    mpu rdb "SELECT 1"              # reuses id=42 (same key)

COMMAND SHORTCUTS
  All 'webApp' subcommands are available at root level:
    mpu webApp get  ≡  mpu get
    mpu webApp set  ≡  mpu set

  (webApp prefix optional)

--fields FLAG  (mpu client <id>)
  Controls output format. Persisted in defaults.

    mpu client 42                      # full JSON object
    mpu client 42 --fields server      # raw value (no JSON)
    mpu client 42 --fields id,server   # JSON with subset of fields
    mpu client 42 --fields ""          # clears saved fields

CLIENT CACHE & SYNC
  'mpu client <id>' checks ~/.config/mpu/db first. If not found, syncs from
  API. 'mpu clients' always does full replace.

TOKEN CACHE
  Auth token valid 10 minutes, cached in ~/.config/mpu/db.
  All sl-back commands reuse automatically.

POSTGRESQL COMMANDS (ldb/rdb/lsdb/rsdb)
  ldb and rdb share client-id default with 'mpu client'.
  lsdb and rsdb use explicit --scheme (and --host for rsdb).

  Local (ldb):
    mpu ldb 54 "SELECT * FROM wb_cards"  # local 127.0.0.1:5441, saves id=54
    mpu ldb "SELECT COUNT(*) FROM x"     # reuses id=54

  Remote (rdb):
    mpu rdb 54 "SELECT * FROM wb_cards"  # resolves host via client.server field
    mpu rdb "SELECT COUNT(*) FROM x"     # reuses id=54

  Local explicit schema (lsdb):
    mpu lsdb --scheme schema_42 "SELECT 1"  # saves --scheme
    mpu lsdb "SELECT 1"                     # reuses saved scheme

  Remote explicit schema (rsdb):
    mpu rsdb --scheme schema_42 --host sl-1 "SELECT 1"  # saves both
    mpu rsdb "SELECT 1"                                  # reuses saved

  Host resolution (rdb/rsdb):
    Client's 'server' field (e.g., "sl-1") → env var "sl_1" → address
    Error if env var missing. Add to ~/.config/mpu/.env:
      sl_1=192.168.150.31
      sl_2=192.168.150.32

CONFIG FILE
  ~/.config/mpu/config.json  — saved defaults and last command.
  ~/.config/mpu/.env         — PostgreSQL and webApp credentials.
  ~/.config/mpu/db           — SQLite cache (tokens, clients).

ENV VARIABLES (.env)
  WebApp:
    WB_PLUS_WEB_APP_URL, WB_PLUS_WEB_APP_EMAIL

  sl-back API:
    NEXT_PUBLIC_SERVER_URL, BASE_API_URL, TOKEN_EMAIL, TOKEN_PASSWORD

  PostgreSQL:
    PG_DB_NAME, PG_LOCAL_PORT, PG_PORT, PG_CLIENT_USER_PASSWORD
    PG_HOST (optional, default 127.0.0.1)
    sl_0, sl_1, ... (host mappings for rdb)`,

	RunE: func(cmd *cobra.Command, args []string) error {
		last := strings.TrimSpace(currentConfig.Command)
		if last == "" {
			return cmd.Help()
		}
		found, _, err := cmd.Find(strings.Fields(last))
		if err != nil || found == cmd {
			return cmd.Help()
		}
		if found.RunE == nil {
			return cmd.Help()
		}
		// Commands that require positional args cannot be repeated without them.
		if found.Args != nil {
			if err := found.Args(found, []string{}); err != nil {
				return fmt.Errorf("cannot repeat %q without arguments", last)
			}
		}
		return found.RunE(found, []string{})
	},

	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		c, err := defaults.Load()
		if err != nil {
			c = defaults.Config{Defaults: make(defaults.Values)}
		}
		currentConfig = c
		return nil
	},

	PersistentPostRunE: func(cmd *cobra.Command, args []string) error {
		// Commands with skipDefaults annotation save config but keep
		// the previous Command value so smart-repeat is unaffected.
		if cmd.Annotations[skipDefaultsAnnotation] == "true" {
			return defaults.Save(currentConfig)
		}
		// Record any leaf command for smart repeat.
		// Strip the binary name so "mpu webApp get" → "webApp get" → findable via cmd.Find.
		path := strings.TrimPrefix(cmd.CommandPath(), "mpu ")
		if path != "" {
			currentConfig.Command = path
		}
		return defaults.Save(currentConfig)
	},
}

func init() {
	rootCmd.AddGroup(
		&cobra.Group{ID: groupSheets, Title: "Google Sheets:"},
		&cobra.Group{ID: groupSL, Title: "sl-back:"},
		&cobra.Group{ID: groupMeta, Title: "Utility:"},
	)
}

func Execute() error {
	// Discover Janet user commands from ~/.config/mpu/commands/ lazily on
	// every Execute so adding a new file doesn't require rebuilding.
	reloadJanetCommands()
	return rootCmd.Execute()
}
