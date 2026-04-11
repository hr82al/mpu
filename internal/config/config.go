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

// PGConfig holds PostgreSQL connection settings for client schema access.
type PGConfig struct {
	Host           string // PG_HOST, default "127.0.0.1"
	LocalPort      string // PG_LOCAL_PORT (required)
	RemotePort     string // PG_PORT (required for remote)
	DBName         string // PG_DB_NAME (required)
	ClientPassword string // PG_CLIENT_USER_PASSWORD (required)

	// Credentials for lrdb / update-spreadsheets (remote, optional).
	MyUserName     string // PG_MY_USER_NAME
	MyUserPassword string // PG_MY_USER_PASSWORD

	// Credentials for lsdb (local, optional).
	MainUserName     string // PG_MAIN_USER_NAME
	MainUserPassword string // PG_MAIN_USER_PASSWORD
}

// LoadPG loads PostgreSQL config from .env.
// Required: PG_DB_NAME, PG_LOCAL_PORT, PG_PORT, PG_CLIENT_USER_PASSWORD.
// Optional: PG_HOST (default 127.0.0.1).
func LoadPG() (*PGConfig, error) {
	loadDotEnv()

	dbName := os.Getenv("PG_DB_NAME")
	if dbName == "" {
		return nil, fmt.Errorf("PG_DB_NAME is not set")
	}
	clientPassword := os.Getenv("PG_CLIENT_USER_PASSWORD")
	if clientPassword == "" {
		return nil, fmt.Errorf("PG_CLIENT_USER_PASSWORD is not set")
	}
	localPort := os.Getenv("PG_LOCAL_PORT")
	if localPort == "" {
		return nil, fmt.Errorf("PG_LOCAL_PORT is not set")
	}
	remotePort := os.Getenv("PG_PORT")
	if remotePort == "" {
		return nil, fmt.Errorf("PG_PORT is not set")
	}

	host := os.Getenv("PG_HOST")
	if host == "" {
		host = "127.0.0.1"
	}

	return &PGConfig{
		Host:           host,
		LocalPort:      localPort,
		RemotePort:     remotePort,
		DBName:         dbName,
		ClientPassword: clientPassword,

		MyUserName:       os.Getenv("PG_MY_USER_NAME"),
		MyUserPassword:   os.Getenv("PG_MY_USER_PASSWORD"),
		MainUserName:     os.Getenv("PG_MAIN_USER_NAME"),
		MainUserPassword: os.Getenv("PG_MAIN_USER_PASSWORD"),
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
