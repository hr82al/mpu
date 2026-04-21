package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"mpu/internal/cache"
	"mpu/internal/config"
	"mpu/internal/defaults"
	"mpu/internal/webapp"

	"github.com/manifoldco/promptui"
	"github.com/sahilm/fuzzy"
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

	switch currentConfig.ForceCache {
	case defaults.CacheModeUse:
		return &webAppCachedClient{}, nil
	case defaults.CacheModeAccumulate:
		cfg, err := config.Load()
		if err != nil {
			return nil, err
		}
		return &webAppCachingClient{inner: webapp.NewClient(cfg.WebAppURL)}, nil
	default:
		cfg, err := config.Load()
		if err != nil {
			return nil, err
		}
		return webapp.NewClient(cfg.WebAppURL), nil
	}
}

// webAppCachedClient reads responses only from cache.
type webAppCachedClient struct{}

func (c *webAppCachedClient) Do(req webapp.Request) (*webapp.Response, error) {
	db, err := cache.Open()
	if err != nil {
		return nil, fmt.Errorf("open cache: %w", err)
	}
	defer db.Close()

	key := webAppCacheKey(req)
	data, ok := db.GetWebAppResponse(key)
	if !ok {
		return nil, fmt.Errorf("no cached response for this request (forceCache=use mode: run the same command without forceCache=use to populate cache first)")
	}

	var resp webapp.Response
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("decode cached response: %w", err)
	}
	return &resp, nil
}

// webAppCachingClient makes real requests and caches results.
type webAppCachingClient struct {
	inner webapp.Client
}

func (c *webAppCachingClient) Do(req webapp.Request) (*webapp.Response, error) {
	resp, err := c.inner.Do(req)
	if err != nil {
		return nil, err
	}

	// Cache the result (best-effort).
	if db, dbErr := cache.Open(); dbErr == nil {
		defer db.Close()
		key := webAppCacheKey(req)
		if data, merr := json.Marshal(resp); merr == nil {
			_ = db.SetWebAppResponse(key, data)
		}
	}

	return resp, nil
}

// webAppCacheKey generates a deterministic cache key for a request.
func webAppCacheKey(req webapp.Request) string {
	// json.Marshal sorts map keys deterministically
	data, _ := json.Marshal(req)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
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

// printJSON writes a value as indented JSON to rootCmd's current output
// writer. Going through rootCmd.OutOrStdout() (instead of os.Stdout
// directly) matters for two callers:
//   * tests that set rootCmd.SetOut(buf) to capture output
//   * the Janet bridge in registerCobraCmd, which also SetOuts a buffer
//     so (mpu/<cmd> ...) returns the command's output as a string
//
// In normal CLI invocation OutOrStdout() falls back to os.Stdout, so
// terminal behaviour is unchanged.
func printJSON(v any) {
	enc := json.NewEncoder(rootCmd.OutOrStdout())
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func printRaw(data json.RawMessage) {
	var v any
	if json.Unmarshal(data, &v) == nil {
		printJSON(v)
	} else {
		fmt.Fprintln(rootCmd.OutOrStdout(), string(data))
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

// resolveRanges returns ranges from -r flags, or builds a full-sheet range
// from -n (sheet-name) when no -r is provided: "SheetName!A:ZZZ".
func resolveRanges(cmd *cobra.Command) ([]string, error) {
	ranges, _ := cmd.Flags().GetStringArray("range")
	if len(ranges) > 0 {
		return ranges, nil
	}
	name, err := requireFlag(cmd, "sheet-name")
	if err != nil {
		return nil, fmt.Errorf("--range (-r) or --sheet-name (-n) is required")
	}
	return []string{"'" + name + "'!A:ZZZ"}, nil
}

const maxMenuItems = 50

// resolveSpreadsheetID resolves a spreadsheet ID from multiple sources.
// Priority: explicit -s flag > positional arg > saved default.
// Returns the spreadsheet ID and remaining args (after consuming the optional query).
func resolveSpreadsheetID(cmd *cobra.Command, args []string) (string, []string, error) {
	// 1. Explicit -s flag wins.
	if cmd.Flags().Changed("spreadsheet-id") {
		val, _ := cmd.Flags().GetString("spreadsheet-id")
		currentConfig.Defaults["spreadsheet-id"] = val
		return val, args, nil
	}

	// 2. Positional arg: first arg that is not JSON.
	if len(args) > 0 && !isJSONArg(args[0]) {
		query := args[0]
		remaining := args[1:]

		sid, err := resolveSpreadsheetQuery(query)
		if err != nil {
			return "", nil, err
		}
		currentConfig.Defaults["spreadsheet-id"] = sid
		return sid, remaining, nil
	}

	// 3. Fallback to saved default.
	if def, ok := currentConfig.Defaults["spreadsheet-id"].(string); ok && def != "" {
		return def, args, nil
	}

	return "", nil, fmt.Errorf("spreadsheet-id is required: use -s, pass a client ID, or a name to search")
}

// resolveSpreadsheetQuery looks up spreadsheets by client ID (number) or fuzzy title search (string).
func resolveSpreadsheetQuery(query string) (string, error) {
	db, err := cache.Open()
	if err != nil {
		return "", err
	}
	defer db.Close()

	if !db.HasSpreadsheets() {
		return "", fmt.Errorf("no cached spreadsheets; run 'mpu update-spreadsheets' first")
	}

	// Try numeric → client ID lookup.
	if clientID, err := strconv.ParseInt(query, 10, 64); err == nil {
		rows, err := db.SpreadsheetsByClientID(clientID)
		if err != nil {
			return "", err
		}
		if len(rows) == 0 {
			return "", fmt.Errorf("no spreadsheets found for client %d; run 'mpu update-spreadsheets' or check the ID", clientID)
		}
		sortActiveFirst(rows)
		return pickSpreadsheet(rows)
	}

	// Text → fuzzy search by title.
	all, err := db.AllSpreadsheets()
	if err != nil {
		return "", err
	}

	source := spreadsheetSource(all)
	matches := fuzzy.FindFrom(strings.ToLower(query), source)
	if len(matches) == 0 {
		return "", fmt.Errorf("no spreadsheets matching %q; run 'mpu update-spreadsheets' or check input", query)
	}

	// Take top N matches (already sorted by score).
	limit := maxMenuItems
	if len(matches) < limit {
		limit = len(matches)
	}
	ranked := make([]cache.SpreadsheetRow, limit)
	for i := 0; i < limit; i++ {
		ranked[i] = all[matches[i].Index]
	}

	// Sort: is_active=true first, then preserve fuzzy rank within each group.
	sortActiveFirst(ranked)

	return pickSpreadsheet(ranked)
}

// pickSpreadsheet shows a selection menu or auto-selects if only one result.
func pickSpreadsheet(rows []cache.SpreadsheetRow) (string, error) {
	if len(rows) == 1 {
		r := rows[0]
		fmt.Fprintf(os.Stderr, "auto-selected: [%d] %s (%s)\n", r.ClientID, r.Title, r.SpreadsheetID)
		return r.SpreadsheetID, nil
	}

	// Compute column widths from data.
	wID, wSID, wTitle, wTmpl := 0, 0, 0, 0
	for _, r := range rows {
		if n := len(strconv.FormatInt(r.ClientID, 10)); n > wID {
			wID = n
		}
		if n := len(r.SpreadsheetID); n > wSID {
			wSID = n
		}
		if n := runeLen(r.Title); n > wTitle {
			wTitle = n
		}
		if n := runeLen(r.TemplateName); n > wTmpl {
			wTmpl = n
		}
	}

	items := make([]string, len(rows))
	for i, r := range rows {
		active := "no "
		if r.IsActive {
			active = "yes"
		}
		idStr := strconv.FormatInt(r.ClientID, 10)
		items[i] = padRight(idStr, wID) + "  " + active + "  " +
			padRight(r.SpreadsheetID, wSID) + "  " +
			padRight(r.Title, wTitle) + "  " + r.TemplateName
	}

	prompt := promptui.Select{
		Label: fmt.Sprintf("Select spreadsheet (%d results)", len(rows)),
		Items: items,
		Size:  20,
	}

	idx, _, err := prompt.Run()
	if err != nil {
		return "", fmt.Errorf("selection cancelled: %w", err)
	}

	r := rows[idx]
	fmt.Fprintf(os.Stderr, "selected: [%d] %s (%s)\n", r.ClientID, r.Title, r.SpreadsheetID)
	return r.SpreadsheetID, nil
}

// sortActiveFirst moves is_active=true rows to the top, preserving relative order within each group.
func sortActiveFirst(rows []cache.SpreadsheetRow) {
	active := make([]cache.SpreadsheetRow, 0, len(rows))
	inactive := make([]cache.SpreadsheetRow, 0, len(rows))
	for _, r := range rows {
		if r.IsActive {
			active = append(active, r)
		} else {
			inactive = append(inactive, r)
		}
	}
	copy(rows, active)
	copy(rows[len(active):], inactive)
}

func runeLen(s string) int {
	return len([]rune(s))
}

func padRight(s string, width int) string {
	n := runeLen(s)
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func isJSONArg(s string) bool {
	return strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[")
}

// readBody returns the JSON body from args[0] or, when args is empty, from r (stdin).
func readBody(bodyArgs []string, r io.Reader) (string, error) {
	if len(bodyArgs) > 0 {
		return bodyArgs[0], nil
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return "", fmt.Errorf("reading stdin: %w", err)
	}
	body := strings.TrimSpace(string(data))
	if body == "" {
		return "", fmt.Errorf("body is required: pass as argument or pipe via stdin")
	}
	return body, nil
}

// spreadsheetSource implements fuzzy.Source for SpreadsheetRow slices.
type spreadsheetSource []cache.SpreadsheetRow

func (s spreadsheetSource) String(i int) string { return strings.ToLower(s[i].Title) }
func (s spreadsheetSource) Len() int            { return len(s) }

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
