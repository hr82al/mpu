package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppSharingCmd = &cobra.Command{
	Use:   "sharing",
	Short: "Set general sharing permissions",
	Example: `  mpu webApp sharing -s <id> --access ANYONE_WITH_LINK --perm EDIT
  mpu webApp sharing -s <id> --access PRIVATE --perm NONE`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		sid, err := requireFlag(cmd, "spreadsheet-id")
		if err != nil {
			return err
		}
		access, err := requireFlag(cmd, "access")
		if err != nil {
			return err
		}
		perm, err := requireFlag(cmd, "perm")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":         "spreadsheets/sharing/set",
			"ssId":           sid,
			"accessType":     access,
			"permissionType": perm,
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
	addSpreadsheetFlag(webAppSharingCmd)
	webAppSharingCmd.Flags().String("access", "", "access type (e.g. ANYONE_WITH_LINK, PRIVATE)")
	webAppSharingCmd.Flags().String("perm", "", "permission type (e.g. EDIT, VIEW)")
	webAppCmd.AddCommand(webAppSharingCmd)
}
