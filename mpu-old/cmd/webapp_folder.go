package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppFolderCmd = &cobra.Command{
	Use:   "folder",
	Short: "Create a folder in Google Drive",
	Example: `  mpu webApp folder --folder-url <parent-url> --name "New Folder"`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := checkProtected(); err != nil {
			return err
		}
		folderURL, err := requireFlag(cmd, "folder-url")
		if err != nil {
			return err
		}
		name, err := requireFlag(cmd, "name")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":    "folder/create",
			"folderUrl": folderURL,
			"name":      name,
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
	webAppFolderCmd.Flags().String("folder-url", "", "parent folder URL")
	webAppFolderCmd.Flags().String("name", "", "folder name")
	webAppCmd.AddCommand(webAppFolderCmd)
}
