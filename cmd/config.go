package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"mpu/internal/defaults"

	"github.com/spf13/cobra"
)

// configOption describes a user-editable field in config.json. Keeping every
// option in one registry is what lets `mpu config` render the full list, show
// allowed values as completion hints, and stay in sync when new options are
// added.
type configOption struct {
	Name   string                                    // JSON key
	Desc   string                                    // shown in listing and completion
	Values []configValue                             // allowed values with descriptions (nil = free-form)
	Get    func(*defaults.Config) string             // current value for display
	Set    func(*defaults.Config, string) error      // parse and assign
}

type configValue struct {
	Value string
	Desc  string
}

var configOptions = []configOption{
	{
		Name: "protected",
		Desc: "block destructive webApp operations (delete, overwrite, etc.)",
		Values: []configValue{
			{"true", "require manual override for destructive ops (safe default)"},
			{"false", "allow destructive ops without prompting"},
		},
		Get: func(c *defaults.Config) string { return strconv.FormatBool(c.Protected) },
		Set: func(c *defaults.Config, v string) error {
			b, err := strconv.ParseBool(v)
			if err != nil {
				return fmt.Errorf("protected: expected true/false, got %q", v)
			}
			c.Protected = b
			return nil
		},
	},
	{
		Name: "forceCache",
		Desc: "cache policy: symbolic mode or TTL in seconds",
		Values: []configValue{
			{"", "default — cache-aside: read from cache, refresh on miss"},
			{"accumulate", "merge new rows into cache without dropping old entries"},
			{"use", "read only from cache, never hit the network"},
			{"<seconds>", "positive integer: TTL in seconds (e.g. 300 → 5 min). Token keeps its fixed 10-min TTL."},
		},
		Get: func(c *defaults.Config) string { return string(c.ForceCache) },
		Set: func(c *defaults.Config, v string) error {
			switch defaults.CacheMode(v) {
			case defaults.CacheModeNone, defaults.CacheModeAccumulate, defaults.CacheModeUse:
				c.ForceCache = defaults.CacheMode(v)
				return nil
			}
			// Numeric TTL (seconds) — delegate validation to CacheTTL so
			// the same parser governs both config set and runtime lookup.
			probe := defaults.Config{ForceCache: defaults.CacheMode(v)}
			if _, ok := probe.CacheTTL(); ok {
				c.ForceCache = defaults.CacheMode(v)
				return nil
			}
			return fmt.Errorf("forceCache: expected \"\"/accumulate/use or a positive integer seconds, got %q", v)
		},
	},
	{
		Name: "remotePostgresOnly",
		Desc: "route ldb/rdb to the remote PostgreSQL instance only",
		Values: []configValue{
			{"true", "never use local PG — always remote"},
			{"false", "default — ldb=local, rdb=remote"},
		},
		Get: func(c *defaults.Config) string { return strconv.FormatBool(c.RemotePostgresOnly) },
		Set: func(c *defaults.Config, v string) error {
			b, err := strconv.ParseBool(v)
			if err != nil {
				return fmt.Errorf("remotePostgresOnly: expected true/false, got %q", v)
			}
			c.RemotePostgresOnly = b
			return nil
		},
	},
}

func findConfigOption(name string) *configOption {
	for i := range configOptions {
		if configOptions[i].Name == name {
			return &configOptions[i]
		}
	}
	return nil
}

var configCmd = &cobra.Command{
	Use:     "config [key] [value]",
	GroupID: groupMeta,
	Short:   "Show or set top-level options in config.json",
	Long: `Manage user-facing options in ~/.config/mpu/config.json.

  mpu config                        # list all options with current values
  mpu config <key>                  # show one option (with allowed values)
  mpu config <key> <value>          # set option and save

Tab completion suggests option names and allowed values.`,
	Args: cobra.MaximumNArgs(2),
	Annotations: map[string]string{
		skipDefaultsAnnotation: "true", // don't clobber smart-repeat target
	},
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		switch len(args) {
		case 0:
			out := make([]string, 0, len(configOptions))
			for _, o := range configOptions {
				out = append(out, o.Name+"\t"+o.Desc)
			}
			return out, cobra.ShellCompDirectiveNoFileComp
		case 1:
			opt := findConfigOption(args[0])
			if opt == nil || len(opt.Values) == 0 {
				return nil, cobra.ShellCompDirectiveNoFileComp
			}
			out := make([]string, 0, len(opt.Values))
			for _, v := range opt.Values {
				label := v.Value
				if label == "" {
					label = `""` // show empty-string choice explicitly
				}
				out = append(out, label+"\t"+v.Desc)
			}
			return out, cobra.ShellCompDirectiveNoFileComp
		}
		return nil, cobra.ShellCompDirectiveNoFileComp
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		out := cmd.OutOrStdout()

		if len(args) == 0 {
			for _, o := range configOptions {
				fmt.Fprintf(out, "%-20s = %s\n", o.Name, formatConfigValue(o.Get(&currentConfig)))
				fmt.Fprintf(out, "%-20s   %s\n", "", o.Desc)
				if len(o.Values) > 0 {
					fmt.Fprintf(out, "%-20s   allowed: %s\n", "", formatAllowed(o.Values))
				}
			}
			return nil
		}

		opt := findConfigOption(args[0])
		if opt == nil {
			return fmt.Errorf("unknown option %q; run 'mpu config' to list", args[0])
		}

		if len(args) == 1 {
			fmt.Fprintf(out, "%s = %s\n", opt.Name, formatConfigValue(opt.Get(&currentConfig)))
			fmt.Fprintln(out, opt.Desc)
			if len(opt.Values) > 0 {
				fmt.Fprintln(out, "allowed:")
				for _, v := range opt.Values {
					fmt.Fprintf(out, "  %-12s %s\n", formatConfigValue(v.Value), v.Desc)
				}
			}
			return nil
		}

		if err := opt.Set(&currentConfig, args[1]); err != nil {
			return err
		}
		if err := defaults.Save(currentConfig); err != nil {
			return fmt.Errorf("save config: %w", err)
		}
		fmt.Fprintf(out, "%s = %s\n", opt.Name, formatConfigValue(opt.Get(&currentConfig)))
		return nil
	},
}

func formatConfigValue(v string) string {
	if v == "" {
		return `""`
	}
	return v
}

func formatAllowed(vs []configValue) string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = formatConfigValue(v.Value)
	}
	return strings.Join(out, " | ")
}

func init() {
	rootCmd.AddCommand(configCmd)
}
