BIN := mpu
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build install

build:
	go build -ldflags="-s -w" -o $(BIN) .

install: build
	install -Dm755 $(BIN) $(INSTALL_DIR)/$(BIN)
