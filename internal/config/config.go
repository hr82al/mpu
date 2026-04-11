package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

type Config struct {
	WebAppURL   string
	WebAppEmail string
}

func Load() (*Config, error) {
	// Try loading .env from current dir and up to 5 levels up
	dir, _ := os.Getwd()
	for i := 0; i < 6; i++ {
		envPath := filepath.Join(dir, ".env")
		if _, err := os.Stat(envPath); err == nil {
			_ = godotenv.Load(envPath)
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	url := os.Getenv("WB_PLUS_WEB_APP_URL")
	if url == "" {
		return nil, fmt.Errorf("WB_PLUS_WEB_APP_URL is not set")
	}

	return &Config{
		WebAppURL:   url,
		WebAppEmail: os.Getenv("WB_PLUS_WEB_APP_EMAIL"),
	}, nil
}
