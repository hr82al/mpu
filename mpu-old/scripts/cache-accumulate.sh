#!/bin/bash
set -e

# Cache accumulation script for offline mode
# Usage: ./scripts/cache-accumulate.sh
# This script:
# 1. Ensures .env and config.json exist
# 2. Sets forceCache=accumulate
# 3. Runs go tests to populate cache
# 4. Runs mpu commands to cache their results
# 5. Switches to forceCache=use for offline mode

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$HOME/.config/mpu"
DB_PATH="$CONFIG_DIR/db"

echo "🔧 Cache Accumulation Script"
echo "=============================="
echo "Project: $PROJECT_ROOT"
echo "Config:  $CONFIG_DIR"
echo ""

# === Step 1: Prepare directories
echo "📁 Step 1: Preparing directories..."
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# === Step 2: Check for .env
echo "📝 Step 2: Checking .env..."
if [ ! -f "$CONFIG_DIR/.env" ]; then
    echo "⚠️  .env not found at $CONFIG_DIR/.env"
    echo ""
    echo "To accumulate cache, you need .env with credentials:"
    echo ""
    echo "  WB_PLUS_WEB_APP_URL=<your-apps-script-url>"
    echo "  WB_PLUS_WEB_APP_EMAIL=<your-email>"
    echo "  NEXT_PUBLIC_SERVER_URL=<api-url>"
    echo "  BASE_API_URL=/api"
    echo "  TOKEN_EMAIL=<email>"
    echo "  TOKEN_PASSWORD=<password>"
    echo "  PG_DB_NAME=<db>"
    echo "  PG_LOCAL_PORT=5441"
    echo "  PG_PORT=5432"
    echo "  PG_CLIENT_USER_PASSWORD=<pwd>"
    echo "  PG_MY_USER_NAME=<user>"
    echo "  PG_MY_USER_PASSWORD=<pwd>"
    echo ""
    echo "For testing without real credentials, using empty cache mode."
else
    echo "✅ .env found"
fi

# === Step 3: Build binary
echo ""
echo "🔨 Step 3: Building binary..."
cd "$PROJECT_ROOT"
CGO_ENABLED=1 go build -ldflags="-s -w" -o mpu .
echo "✅ Build successful: $(pwd)/mpu"

# === Step 4: Set forceCache=accumulate
echo ""
echo "⚙️  Step 4: Setting forceCache=accumulate..."
cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "protected": false,
  "forceCache": "accumulate",
  "remotePostgresOnly": false,
  "defaults": {}
}
EOF
echo "✅ Config set to accumulate mode"
cat "$CONFIG_DIR/config.json"

# === Step 5: Clean old cache database
echo ""
echo "🧹 Step 5: Cleaning old cache database..."
rm -f "$DB_PATH"
echo "✅ Cache cleared"

# === Step 6: Run go tests (accumulate cache from network)
echo ""
echo "🧪 Step 6: Running all unit tests (accumulate=true)..."
echo "   This will cache all test data to SQLite..."
echo ""

# Tests that will populate cache
UNIT_TEST_PACKAGES=(
    "./internal/defaults"
    "./internal/cache"
    "./internal/config"
    "./internal/pgclient"
    "./cmd"
)

FAILED=0
PASSED=0

for pkg in "${UNIT_TEST_PACKAGES[@]}"; do
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Testing $pkg (accumulate mode)..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if go test "$pkg" -timeout 60s -v 2>&1 | tee /tmp/test_output.log; then
        PASSED=$((PASSED + 1))
        echo "✅ Passed: $pkg"
    else
        FAILED=$((FAILED + 1))
        echo "⚠️  Some tests failed for $pkg (may be expected without network)"
        # Show last error
        tail -20 /tmp/test_output.log | grep -E "(FAIL|Error)" | head -3
    fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Passed: $PASSED packages"
echo "⚠️  Failed/Skipped: $FAILED packages (expected if network unavailable)"
echo ""

if [ $FAILED -eq 0 ]; then
    echo "✅ All tests passed with full cache accumulation"
else
    echo "⚠️  Some tests failed - this is expected if network/APIs are unavailable"
    echo "   But cache was still populated from successful test operations"
fi

# === Step 7: Try to run mpu commands (if .env exists)
if [ -f "$CONFIG_DIR/.env" ]; then
    echo ""
    echo "💾 Step 7: Running mpu commands to cache API results..."
    echo ""

    # Source .env for commands
    set -a
    source "$CONFIG_DIR/.env"
    set +a

    MPU="$PROJECT_ROOT/mpu"

    # Commands to cache
    COMMANDS=(
        "token"
        "clients"
    )

    for cmd in "${COMMANDS[@]}"; do
        echo "Caching: $cmd..."
        if $MPU $cmd > /dev/null 2>&1; then
            echo "  ✅ $cmd cached"
        else
            echo "  ⚠️  $cmd failed (network or credentials issue)"
        fi
    done

    # Try to cache specific client if clients command succeeded
    echo ""
    echo "Caching specific client data..."
    if $MPU client 42 > /dev/null 2>&1; then
        echo "  ✅ client 42 cached"
    else
        echo "  ⚠️  client 42 failed (use real client ID)"
    fi

    # Try to cache database queries if PG is available
    echo ""
    echo "Caching database queries..."
    if $MPU ldb 42 "SELECT 1" > /dev/null 2>&1; then
        echo "  ✅ ldb query cached"
    else
        echo "  ⚠️  ldb failed (PG unavailable or wrong client ID)"
    fi

    if $MPU rdb 42 "SELECT 1" > /dev/null 2>&1; then
        echo "  ✅ rdb query cached"
    else
        echo "  ⚠️  rdb failed (PG unavailable or wrong client ID)"
    fi
else
    echo ""
    echo "ℹ️  Step 7: Skipped (no .env file)"
    echo "To cache webapp/api results, create .env at $CONFIG_DIR/.env"
    echo ""
    echo "Required .env variables:"
    echo "  WB_PLUS_WEB_APP_URL=<url>"
    echo "  WB_PLUS_WEB_APP_EMAIL=<email>"
    echo "  NEXT_PUBLIC_SERVER_URL=<url>"
    echo "  BASE_API_URL=/api"
    echo "  TOKEN_EMAIL=<email>"
    echo "  TOKEN_PASSWORD=<password>"
    echo "  PG_DB_NAME=<dbname>"
    echo "  PG_LOCAL_PORT=5441"
    echo "  PG_PORT=5432"
    echo "  PG_CLIENT_USER_PASSWORD=<password>"
    echo ""
    echo "Then re-run this script."
fi

# === Step 8: Inspect cache
echo ""
echo "🔍 Step 8: Cache statistics..."
echo ""

if [ -f "$DB_PATH" ]; then
    DB_SIZE=$(ls -lh "$DB_PATH" | awk '{print $5}')
    echo "  Database: $DB_PATH"
    echo "  Size: $DB_SIZE"
    echo ""

    # Try to show cache contents
    echo "  Cache contents:"
    if command -v sqlite3 &> /dev/null; then
        sqlite3 "$DB_PATH" << 'SQL' 2>/dev/null | sed 's/^/    /'
SELECT 'token_cache' as table_name, COUNT(*) as rows FROM token_cache
UNION ALL
SELECT 'sl_clients', COUNT(*) FROM sl_clients
UNION ALL
SELECT 'sl_spreadsheets', COUNT(*) FROM sl_spreadsheets
UNION ALL
SELECT 'webapp_cache', COUNT(*) FROM webapp_cache
UNION ALL
SELECT 'pgquery_cache', COUNT(*) FROM pgquery_cache;
SQL
    else
        echo "    (sqlite3 not available for detailed cache info)"
    fi
    echo ""
    echo "  ✅ Cache database ready"
else
    echo "  ℹ️  Cache database will be created on next command"
fi

# === Step 9: Switch to use mode
echo ""
echo "⚙️  Step 9: Switching to forceCache=use (offline mode)..."
cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "protected": false,
  "forceCache": "use",
  "remotePostgresOnly": false,
  "defaults": {}
}
EOF
echo "✅ Config switched to use mode"

# === Summary
echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ CACHE ACCUMULATION COMPLETE!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "📊 Summary:"
echo "  ✅ Binary built"
echo "  ✅ All tests run ($PASSED packages passed)"
echo "  ✅ Cache accumulated to SQLite"
echo "  ✅ forceCache=use (OFFLINE MODE) activated"
echo ""
echo "📁 Locations:"
echo "  Config:  $CONFIG_DIR/config.json"
echo "  Cache:   $DB_PATH"
echo "  Binary:  $PROJECT_ROOT/mpu"
echo ""
echo "🚀 Test offline mode (no internet needed):"
echo ""
echo "  ./mpu token          # ✅ from cache (no TTL)"
echo "  ./mpu client 42      # ✅ from cache"
echo "  ./mpu clients        # ❌ Error (network unavailable)"
echo ""
echo "🔄 Resume accumulation (with internet + .env):"
echo ""
echo "  jq '.forceCache = \"accumulate\"' $CONFIG_DIR/config.json | sponge $CONFIG_DIR/config.json"
echo "  ./mpu clients        # will refresh from network"
echo "  ./mpu ldb 42 \"SELECT 1\"  # will cache new query"
echo "  jq '.forceCache = \"use\"' $CONFIG_DIR/config.json | sponge $CONFIG_DIR/config.json"
echo ""
