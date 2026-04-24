package webapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client interface {
	Do(req Request) (*Response, error)
}

type client struct {
	url        string
	maxRetries int
	httpClient *http.Client
}

func NewClient(url string) Client {
	return &client{
		url:        url,
		maxRetries: 9,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

func (c *client) Do(req Request) (*Response, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		resp, err := c.httpClient.Post(c.url, "application/json", bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}

		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode >= 404 {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}

		var result Response
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, fmt.Errorf("unmarshal response: %w\nbody: %s", err, string(data))
		}

		if !result.Success && result.Error != "" {
			if result.Error == "Quota exceeded" {
				time.Sleep(60 * time.Second)
				continue
			}
		}

		return &result, nil
	}

	if lastErr != nil {
		return nil, fmt.Errorf("all %d attempts failed, last error: %w", c.maxRetries+1, lastErr)
	}
	return nil, fmt.Errorf("all %d attempts failed", c.maxRetries+1)
}
