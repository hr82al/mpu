BIN := mpu
INSTALL_DIR := $(HOME)/.local/bin
CONFIG_DIR := $(HOME)/.config/mpu

.PHONY: build install

build:
	CGO_ENABLED=1 go build -ldflags="-s -w" -o $(BIN) .

install: build
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
