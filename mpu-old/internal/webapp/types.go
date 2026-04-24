package webapp

import "encoding/json"

type Request map[string]interface{}

type Response struct {
	Success       bool            `json:"success"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         string          `json:"error,omitempty"`
	Action        string          `json:"action,omitempty"`
	EffectiveUser string          `json:"effectiveUser,omitempty"`
}
