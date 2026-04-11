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
	Short: "Multi-purpose utility",
	Long: `mpu — multi-purpose CLI for Google Sheets and sl-back.

SMART REPEAT
  Running 'mpu' with no arguments repeats the last command.
  Commands that require a positional argument cannot be auto-repeated and
  will print a clear error instead.

    mpu get -s SHEET_ID -n Sheet1   # run and remember flags
    mpu                             # repeats: mpu get (with saved -s and -n)

REMEMBERED FLAGS
  Most flags are persisted in ~/.config/mpu/config.json after the first use.
  On subsequent calls you can omit them entirely:

    mpu get -s 1eJfR... -n Prices  # saves -s and -n
    mpu get                         # reuses saved -s and -n
    mpu set '[{"a":1}]'            # also reuses saved -s and -n
    mpu get -n Other                # overrides -n for this run and saves it

  Flags that support defaults:
    -s / --spreadsheet-id   Google Sheets spreadsheet ID
    -n / --sheet-name       Sheet tab name
    --fields                Fields to return in 'client' command (see below)

COMMAND SHORTCUTS
  All 'webApp' subcommands are available at the root level:

    mpu webApp get   ≡   mpu get
    mpu webApp set   ≡   mpu set

  The 'webApp' prefix can always be omitted.

--fields FLAG  (mpu client <id>)
  Controls which fields are returned. Persisted in defaults.

    mpu client 42                      # full JSON object
    mpu client 42 --fields server      # sl-1        (raw value, no JSON)
    mpu client 42 --fields id,server   # {"id":42,"server":"sl-1"}
    mpu client 42 --fields ""          # clears saved fields → full JSON

  On subsequent calls, omit --fields to reuse the last value:

    mpu client 42 --fields server      # saves "server"
    mpu client 99                      # returns only "server" field of client 99

CLIENT CACHE
  'mpu client <id>' checks ~/.config/mpu/db first.
  If the client is not cached, it calls the API (same as 'mpu clients'),
  syncs everything, then returns the requested record.
  'mpu clients' always does a full replace of the cached list.

TOKEN CACHE
  The auth token is valid for 10 minutes and cached in ~/.config/mpu/db.
  All sl-back commands reuse it automatically — no manual 'mpu token' needed.

CONFIG FILE
  ~/.config/mpu/config.json  — saved flag defaults and last command name.
  Set protected=true to block destructive webApp operations (set/delete/etc).`,

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
	return rootCmd.Execute()
}
