package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"mpu/internal/config"
	"mpu/internal/defaults"
	"mpu/internal/webapp"

	"github.com/spf13/cobra"
)

// currentConfig holds the loaded config for the duration of a command run.
var currentConfig defaults.Config

var webAppCmd = &cobra.Command{
	Use:     "webApp",
	Aliases: []string{"wa"},
	Short:   "Google Sheets operations via Apps Script",
	Long: `Interact with Google Sheets through a Google Apps Script proxy.
Credentials are loaded from .env (WB_PLUS_WEB_APP_URL).`,
}

func init() {
	rootCmd.AddCommand(webAppCmd)
}

// testClientFn can be set in tests to inject a mock client.
var testClientFn func() (webapp.Client, error)

func newClient() (webapp.Client, error) {
	if testClientFn != nil {
		return testClientFn()
	}
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	return webapp.NewClient(cfg.WebAppURL), nil
}

// requireFlag returns the value of a string flag, falling back to saved defaults.
// If the flag was explicitly provided, the new value is saved to currentConfig.Defaults.
func requireFlag(cmd *cobra.Command, name string) (string, error) {
	if cmd.Flags().Changed(name) {
		val, _ := cmd.Flags().GetString(name)
		currentConfig.Defaults[name] = val
		return val, nil
	}
	if def, ok := currentConfig.Defaults[name].(string); ok && def != "" {
		return def, nil
	}
	return "", fmt.Errorf("--%s is required", name)
}

// getIntFlag returns the value of an int flag, falling back to saved defaults,
// then to the cobra-registered default. Saves explicitly provided values.
func getIntFlag(cmd *cobra.Command, name string) int {
	if cmd.Flags().Changed(name) {
		val, _ := cmd.Flags().GetInt(name)
		currentConfig.Defaults[name] = float64(val)
		return val
	}
	if v, ok := currentConfig.Defaults[name]; ok {
		if fval, ok := v.(float64); ok {
			return int(fval)
		}
	}
	val, _ := cmd.Flags().GetInt(name)
	return val
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func printRaw(data json.RawMessage) {
	var v any
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

// checkProtected returns an error when protected=true is set in config.json.
// Called at the start of any destructive or structural command.
// addSpreadsheetFlag adds -s / --spreadsheet-id to cmd as a local flag.
func addSpreadsheetFlag(cmd *cobra.Command) {
	cmd.Flags().StringP("spreadsheet-id", "s", "", "spreadsheet ID")
}

// addSheetNameFlag adds -n / --sheet-name to cmd as a local flag.
func addSheetNameFlag(cmd *cobra.Command) {
	cmd.Flags().StringP("sheet-name", "n", "", "sheet tab name")
}

func checkProtected() error {
	if currentConfig.Protected {
		return fmt.Errorf(
			"operation blocked: protected=true in %s\n"+
				"Set protected=false manually to allow destructive operations.",
			defaults.FilePath(),
		)
	}
	return nil
}
