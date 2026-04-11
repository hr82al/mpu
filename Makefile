BIN := mpu
INSTALL_DIR := $(HOME)/.local/bin
CONFIG_DIR := $(HOME)/.config/mpu
JANET_DIR := $(CONFIG_DIR)/janet
ENVAULT := scripts/envault.sh

.PHONY: build install env-encrypt env-decrypt env-sync

build:
	CGO_ENABLED=1 go build -ldflags="-s -w" -o $(BIN) .

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
	@mkdir -p $(JANET_DIR)
	@for f in janet/*.janet; do \
		[ -f "$$f" ] && install -Dm644 "$$f" "$(JANET_DIR)/$$(basename $$f)" && \
		echo "Copied $$f → $(JANET_DIR)/$$(basename $$f)"; \
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
