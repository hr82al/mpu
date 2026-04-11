package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"mpu/internal/config"
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

var webAppCmd = &cobra.Command{
	Use:     "webApp",
	Aliases: []string{"wa"},
	Short:   "Google Sheets operations via Apps Script",
	Long: `Interact with Google Sheets through a Google Apps Script proxy.
Credentials are loaded from .env (WB_PLUS_WEB_APP_URL).`,
}

func init() {
	webAppCmd.PersistentFlags().StringP("spreadsheet-id", "s", "", "spreadsheet ID")
	webAppCmd.PersistentFlags().StringP("sheet-name", "n", "", "sheet tab name")

	rootCmd.AddCommand(webAppCmd)
}

func newClient() (webapp.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	return webapp.NewClient(cfg.WebAppURL), nil
}

func requireFlag(cmd *cobra.Command, name string) (string, error) {
	val, _ := cmd.Flags().GetString(name)
	if val == "" {
		return "", fmt.Errorf("--%s is required", name)
	}
	return val, nil
}

func printJSON(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func printRaw(data json.RawMessage) {
	var v interface{}
	if json.Unmarshal(data, &v) == nil {
		printJSON(v)
	} else {
		fmt.Println(string(data))
	}
}

func checkResp(resp *webapp.Response) error {
	if !resp.Success {
		return fmt.Errorf("webApp error: %s", resp.Error)
	}
	return nil
}
