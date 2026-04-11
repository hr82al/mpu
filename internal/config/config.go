package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	WebAppURL   string
	WebAppEmail string
}

// AuthConfig holds credentials for the sl-back HTTP API.
type AuthConfig struct {
	// APIURL is the base API URL, e.g. "http://localhost:5000/api".
	// Built from NEXT_PUBLIC_SERVER_URL + BASE_API_URL.
	APIURL   string
	Email    string
	Password string
}

func Load() (*Config, error) {
	loadDotEnv()

	url := os.Getenv("WB_PLUS_WEB_APP_URL")
	if url == "" {
		return nil, fmt.Errorf("WB_PLUS_WEB_APP_URL is not set")
	}

	return &Config{
		WebAppURL:   url,
		WebAppEmail: os.Getenv("WB_PLUS_WEB_APP_EMAIL"),
	}, nil
}

// LoadAuth loads sl-back API credentials from the .env file.
// Required vars: NEXT_PUBLIC_SERVER_URL, BASE_API_URL, TOKEN_EMAIL, TOKEN_PASSWORD.
func LoadAuth() (*AuthConfig, error) {
	loadDotEnv()

	serverURL := strings.TrimRight(os.Getenv("NEXT_PUBLIC_SERVER_URL"), "/")
	if serverURL == "" {
		return nil, fmt.Errorf("NEXT_PUBLIC_SERVER_URL is not set")
	}
	baseAPI := os.Getenv("BASE_API_URL")

	email := os.Getenv("TOKEN_EMAIL")
	if email == "" {
		return nil, fmt.Errorf("TOKEN_EMAIL is not set")
	}
	password := os.Getenv("TOKEN_PASSWORD")
	if password == "" {
		return nil, fmt.Errorf("TOKEN_PASSWORD is not set")
	}

	return &AuthConfig{
		APIURL:   serverURL + baseAPI,
		Email:    email,
		Password: password,
	}, nil
}

// loadDotEnv loads ~/.config/mpu/.env if it exists.
func loadDotEnv() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	envPath := filepath.Join(home, ".config", "mpu", ".env")
	if _, err := os.Stat(envPath); err == nil {
		_ = godotenv.Load(envPath)
	}
}
