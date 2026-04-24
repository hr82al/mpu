BIN := mpu
INSTALL_DIR := $(HOME)/.local/bin
CONFIG_DIR := $(HOME)/.config/mpu
JANET_DIR := $(CONFIG_DIR)/janet
ENVAULT := scripts/envault.sh

.PHONY: build install test test-integration env-encrypt env-decrypt env-sync

build:
	CGO_ENABLED=1 go build -ldflags="-s -w" -o $(BIN) .

# Full unit-test suite: Go tests + Janet tests executed by the real mpu
# binary so scripts run in the same VM the user hits in production. Janet
# tests are plain .janet files in janet/tests/; each one raises on failure
# (assert), which bubbles up as a non-zero exit so `make` stops on the
# first break.
#
# internal/webapp/ is excluded because it hits the live Apps Script API
# and needs .env credentials; run `make test-integration` for that layer.
test: build
	go test $$(go list ./... | grep -v /internal/webapp) -timeout 120s
	@for f in janet/tests/*_test.janet; do \
		[ -e "$$f" ] || continue; \
		echo "→ janet: $$f"; \
		MPU_JANET_DIR=$(PWD)/janet ./$(BIN) repl "$$f" || exit 1; \
	done
	@echo "✓ all tests passed"

# Integration tests (hit real Google Apps Script + Sheets). Requires
# ~/.config/mpu/.env with WB_PLUS_WEB_APP_URL and test-spreadsheet access.
test-integration:
	go test ./internal/webapp/ -v -timeout 120s

install: build ensure-env
	install -Dm755 $(BIN) $(INSTALL_DIR)/$(BIN)
	@mkdir -p $(CONFIG_DIR)
	@if [ -f .env ] && [ ! -f $(CONFIG_DIR)/.env ]; then \
		install -Dm600 .env $(CONFIG_DIR)/.env; \
		echo "Copied .env → $(CONFIG_DIR)/.env"; \
	elif [ ! -f .env ]; then \
		echo "No .env found in current directory — skipping"; \
	else \
		echo "$(CONFIG_DIR)/.env already exists — skipping"; \
	fi
	@mkdir -p $(JANET_DIR) $(JANET_DIR)/commands $(JANET_DIR)/tests $(JANET_DIR)/formula-fns
	@for f in janet/*.janet; do \
		[ -f "$$f" ] && install -Dm644 "$$f" "$(JANET_DIR)/$$(basename $$f)" && \
		echo "Copied $$f → $(JANET_DIR)/$$(basename $$f)"; \
	done
	@for f in janet/commands/*.janet; do \
		[ -f "$$f" ] && install -Dm644 "$$f" "$(JANET_DIR)/commands/$$(basename $$f)" && \
		echo "Copied $$f → $(JANET_DIR)/commands/$$(basename $$f)"; \
	done
	@for f in janet/tests/*.janet; do \
		[ -f "$$f" ] && install -Dm644 "$$f" "$(JANET_DIR)/tests/$$(basename $$f)" && \
		echo "Copied $$f → $(JANET_DIR)/tests/$$(basename $$f)"; \
	done
	@for f in janet/formula-fns/*.janet; do \
		[ -f "$$f" ] && install -Dm644 "$$f" "$(JANET_DIR)/formula-fns/$$(basename $$f)" && \
		echo "Copied $$f → $(JANET_DIR)/formula-fns/$$(basename $$f)"; \
	done
	@echo "Janet scripts installed to $(JANET_DIR)"

# ── .env encryption ──────────────────────────────────────────────
# .env.enc is committed to git; .env is in .gitignore.
# Triple encryption: AES-256-CTR → ChaCha20 → Camellia-256-CTR.
# All operations ask for confirmation; skip with MPU_ENV_SKIP=1.

# Encrypt .env → .env.enc (interactive, for git commit).
env-encrypt:
	@$(ENVAULT) encrypt .env .env.enc

# Decrypt .env.enc → .env (interactive, after git clone).
env-decrypt:
	@$(ENVAULT) decrypt .env.enc .env

# Sync: re-encrypt only if .env changed (interactive).
env-sync:
	@$(ENVAULT) sync .env .env.enc

# Auto-decrypt if .env missing but .env.enc exists (interactive prompt).
ensure-env:
	@$(ENVAULT) ensure .env .env.enc
