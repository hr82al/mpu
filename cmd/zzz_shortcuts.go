package cmd

// zzz_shortcuts.go registers root-level aliases for all webApp subcommands so
// that e.g. "mpu get" works the same as "mpu webApp get".
//
// The file is named with "zzz_" prefix to guarantee its init() runs after all
// webapp_*.go init() functions (Go processes files alphabetically), ensuring
// that flags are already registered on the source commands before we copy them.

import "github.com/spf13/cobra"

const groupWebApp = "webApp"

// shortcut creates a root-level alias that shares RunE with src and copies its
// local flags. The Annotation["commandGroup"] is used by root's PersistentPostRunE
// to record which group was last used.
func shortcut(src *cobra.Command) *cobra.Command {
	dst := &cobra.Command{
		Use:         src.Use,
		Short:       src.Short,
		Args:        src.Args,
		Example:     src.Example,
		RunE:        src.RunE,
		Annotations: map[string]string{"commandGroup": groupWebApp},
	}
	dst.Flags().AddFlagSet(src.Flags())
	return dst
}

func init() {
	// Simple (leaf) commands.
	for _, src := range []*cobra.Command{
		webAppGetCmd,
		webAppSetCmd,
		webAppInsertCmd,
		webAppUpsertCmd,
		webAppKeysCmd,
		webAppInfoCmd,
		webAppBatchGetCmd,
		webAppBatchUpdateCmd,
		webAppValuesUpdateCmd,
		webAppDeleteCmd,
		webAppCreateCmd,
		webAppCopyCmd,
		webAppFolderCmd,
		webAppSharingCmd,
		webAppProtectionCmd,
	} {
		rootCmd.AddCommand(shortcut(src))
	}

	// editors has sub-subcommands.
	editorsShortcut := &cobra.Command{
		Use:         webAppEditorsCmd.Use,
		Short:       webAppEditorsCmd.Short,
		Annotations: map[string]string{"commandGroup": groupWebApp},
	}
	for _, src := range []*cobra.Command{
		editorsGetCmd,
		editorsAddCmd,
		editorsSetCmd,
		editorsRemoveCmd,
	} {
		editorsShortcut.AddCommand(shortcut(src))
	}
	rootCmd.AddCommand(editorsShortcut)
}
