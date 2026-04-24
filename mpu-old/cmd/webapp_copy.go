package cmd

import (
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppCopyCmd = &cobra.Command{
	Use:   "copy",
	Short: "Copy a spreadsheet from template",
	Example: `  mpu webApp copy --folder-url <url> --name "Copy" --template <spreadsheet-id>`,
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
		template, err := requireFlag(cmd, "template")
		if err != nil {
			return err
		}

		c, err := newClient()
		if err != nil {
			return err
		}

		resp, err := c.Do(webapp.Request{
			"action":    "spreadsheets/copy",
			"folderUrl": folderURL,
			"name":      name,
			"template":  template,
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
	webAppCopyCmd.Flags().String("folder-url", "", "destination folder URL")
	webAppCopyCmd.Flags().String("name", "", "new spreadsheet name")
	webAppCopyCmd.Flags().String("template", "", "template spreadsheet ID")
	webAppCmd.AddCommand(webAppCopyCmd)
}
