package cmd

// zzz_shortcuts.go registers root-level aliases for all webApp subcommands so
// that e.g. "mpu get" works the same as "mpu webApp get".
//
// The file is named with "zzz_" prefix to guarantee its init() runs after all
// webapp_*.go init() functions (Go processes files alphabetically), ensuring
// that flags are already registered on the source commands before we copy them.

import "github.com/spf13/cobra"

// shortcut creates a root-level alias that shares RunE with src and copies its
// local flags. GroupID must be set by the caller for top-level commands.
func shortcut(src *cobra.Command, groupID string) *cobra.Command {
	dst := &cobra.Command{
		Use:         src.Use,
		Short:       src.Short,
		Args:        src.Args,
		Example:     src.Example,
		RunE:        src.RunE,
		GroupID:     groupID,
		Annotations: map[string]string{"commandGroup": groupWebApp},
	}
	dst.Flags().AddFlagSet(src.Flags())
	return dst
}

// subShortcut creates an alias for a sub-subcommand (no GroupID needed).
func subShortcut(src *cobra.Command) *cobra.Command {
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
	// Simple (leaf) commands — registered directly at root, get groupSheets.
	for _, src := range []*cobra.Command{
		webAppGetCmd,
		webAppSetCmd,
		webAppInsertCmd,
		webAppUpsertCmd,
		webAppKeysCmd,
		webAppInfoCmd,
		webAppBatchGetCmd,
		webAppBatchGetAllCmd,
		webAppBatchUpdateCmd,
		webAppValuesUpdateCmd,
		webAppDeleteCmd,
		webAppCreateCmd,
		webAppCopyCmd,
		webAppFolderCmd,
		webAppSharingCmd,
		webAppProtectionCmd,
	} {
		rootCmd.AddCommand(shortcut(src, groupSheets))
	}

	// editors has sub-subcommands — the parent gets groupSheets, children get no group.
	editorsShortcut := &cobra.Command{
		Use:         webAppEditorsCmd.Use,
		Short:       webAppEditorsCmd.Short,
		GroupID:     groupSheets,
		Annotations: map[string]string{"commandGroup": groupWebApp},
	}
	for _, src := range []*cobra.Command{
		editorsGetCmd,
		editorsAddCmd,
		editorsSetCmd,
		editorsRemoveCmd,
	} {
		editorsShortcut.AddCommand(subShortcut(src))
	}
	rootCmd.AddCommand(editorsShortcut)

	// webApp parent itself goes under sheets group.
	webAppCmd.GroupID = groupSheets
}
