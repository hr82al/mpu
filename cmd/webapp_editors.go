package cmd

import (
	"fmt"

	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppEditorsCmd = &cobra.Command{
	Use:   "editors",
	Short: "Manage spreadsheet editors",
}

var editorsGetCmd = &cobra.Command{
	Use:     "get",
	Short:   "List editors",
	Example: `  mpu webApp editors get -s <spreadsheet-id>`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		resp, err := c.Do(webapp.Request{
			"action": "spreadsheets/editors/get",
			"ssId":   sid,
		})
		if err != nil {
			return err
		}
		if err := checkResp(resp); err != nil {
			return err
		}
		printRaw(resp.Result)
		return nil
	},
}

var editorsAddCmd = &cobra.Command{
	Use:     "add",
	Short:   "Add editors",
	Example: `  mpu webApp editors add -s <id> -e user@example.com -e other@example.com`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		editors, _ := cmd.Flags().GetStringArray("editor")
		if len(editors) == 0 {
			return fmt.Errorf("--editor (-e) is required")
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		resp, err := c.Do(webapp.Request{
			"action":  "spreadsheets/editors/add",
			"ssId":    sid,
			"editors": editors,
		})
		if err != nil {
			return err
		}
		if err := checkResp(resp); err != nil {
			return err
		}
		printRaw(resp.Result)
		return nil
	},
}

var editorsSetCmd = &cobra.Command{
	Use:     "set",
	Short:   "Set exact list of editors",
	Example: `  mpu webApp editors set -s <id> -e user@example.com`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		editors, _ := cmd.Flags().GetStringArray("editor")
		if len(editors) == 0 {
			return fmt.Errorf("--editor (-e) is required")
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		resp, err := c.Do(webapp.Request{
			"action":  "spreadsheets/editors/set",
			"ssId":    sid,
			"editors": editors,
		})
		if err != nil {
			return err
		}
		if err := checkResp(resp); err != nil {
			return err
		}
		printRaw(resp.Result)
		return nil
	},
}

var editorsRemoveCmd = &cobra.Command{
	Use:     "remove",
	Short:   "Remove editors",
	Example: `  mpu webApp editors remove -s <id> -e user@example.com`,
	RunE: func(cmd *cobra.Command, args []string) error {
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		editors, _ := cmd.Flags().GetStringArray("editor")
		if len(editors) == 0 {
			return fmt.Errorf("--editor (-e) is required")
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		resp, err := c.Do(webapp.Request{
			"action":  "spreadsheets/editors/remove",
			"ssId":    sid,
			"editors": editors,
		})
		if err != nil {
			return err
		}
		if err := checkResp(resp); err != nil {
			return err
		}
		printRaw(resp.Result)
		return nil
	},
}

func init() {
	editorsAddCmd.Flags().StringArrayP("editor", "e", nil, "editor email (repeatable)")
	editorsSetCmd.Flags().StringArrayP("editor", "e", nil, "editor email (repeatable)")
	editorsRemoveCmd.Flags().StringArrayP("editor", "e", nil, "editor email (repeatable)")

	webAppEditorsCmd.AddCommand(editorsGetCmd, editorsAddCmd, editorsSetCmd, editorsRemoveCmd)
	webAppCmd.AddCommand(webAppEditorsCmd)
}
