package lib

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type ErrorPayload struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Code    *string `json:"code"`
}

func code(value string) *string { return &value }

func IsClientClosedMessage(message string) bool {
	message = strings.ToLower(message)
	for _, phrase := range []string{"client closed request", "client cancelled request", "client canceled request", "request canceled by client", "request cancelled by client"} {
		if strings.Contains(message, phrase) {
			return true
		}
	}
	return false
}

func ClassifyError(status int, errorType, message string) ErrorPayload {
	text := strings.ToLower(message)
	result := func(kind, value string) ErrorPayload {
		return ErrorPayload{Message: message, Type: kind, Code: code(value)}
	}
	if errorType == "client_cancelled" {
		return result("client_cancelled", "client_cancelled")
	}
	if status == 499 || errorType == "client_closed_request" || IsClientClosedMessage(text) {
		return result("invalid_request_error", "client_closed_request")
	}
	if containsAny(text, "context_length_exceeded", "context window", "context length", "maximum context", "too many tokens") {
		return result("invalid_request_error", "context_length_exceeded")
	}
	if strings.Contains(text, "cursor resource limit exceeded") {
		return result("invalid_request_error", "tool_catalog_too_large")
	}
	if strings.Contains(text, "cursor rate limit exceeded") {
		return result("rate_limit_error", "rate_limit_exceeded")
	}
	if containsAny(text, "insufficient_quota", "exceeded your current quota", "quota exhausted", "account quota exceeded", "monthly quota exceeded", "daily quota exceeded") {
		return result("insufficient_quota", "insufficient_quota")
	}
	if status == 429 || containsAny(text, "rate limit", "rate limited", "too many requests", "resource_exhausted", "resource exhausted", "throttling") {
		return result("rate_limit_error", "rate_limit_exceeded")
	}
	if errorType == "origin_rejected" {
		return result("invalid_request_error", "origin_rejected")
	}
	if status == 401 || errorType == "authentication_error" || authenticationMessage(text) {
		return result("authentication_error", "invalid_api_key")
	}
	if (status == 403 || errorType == "permission_error") && subscriptionMessage(text) {
		return result("permission_error", "subscription_required")
	}
	if status == 403 || errorType == "permission_error" || permissionMessage(text) {
		return result("permission_error", "permission_denied")
	}
	if status == 503 || containsAny(text, "overloaded", "server is busy", "temporarily unavailable") {
		return result("server_error", "server_is_overloaded")
	}
	if containsAny(text, "validationexception", "invalid request", "model unavailable", "model not found", "unsupported model", "profile arn", "wrong region", "invalid region") || status == 400 || errorType == "invalid_request_error" {
		return result("invalid_request_error", "invalid_request_error")
	}
	if status >= 500 {
		return result("server_error", "upstream_server_error")
	}
	if errorType == "" {
		return ErrorPayload{Message: message}
	}
	return result(errorType, errorType)
}

var retryMessagePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)try again in (\d+(?:\.\d+)?)\s*s`),
	regexp.MustCompile(`(?i)retry after (\d+(?:\.\d+)?)\s*s`),
	regexp.MustCompile(`(?i)retry[- ]after[:\s]+(\d+)`),
}

func ParseRetryAfterFromMessage(message string) (int, bool) {
	for _, pattern := range retryMessagePatterns {
		match := pattern.FindStringSubmatch(message)
		if len(match) != 2 {
			continue
		}
		seconds, err := strconv.ParseFloat(match[1], 64)
		if err == nil && seconds > 0 {
			return int(math.Ceil(seconds)), true
		}
	}
	return 0, false
}

func InferHTTPStatus(message string) int {
	text := strings.ToLower(message)
	switch {
	case IsClientClosedMessage(text):
		return 499
	case strings.Contains(text, "cursor resource limit exceeded"):
		return 400
	case containsAny(text, "resource_exhausted", "resource exhausted", "rate limit", "too many requests", "throttling"):
		return 429
	case authenticationMessage(text):
		return 401
	case subscriptionMessage(text) || permissionMessage(text):
		return 403
	case containsAny(text, "unavailable", "overloaded", "temporarily", "server is busy"):
		return 503
	case containsAny(text, "invalid", "not found", "unsupported", "malformed", "unimplemented"):
		return 400
	case containsAny(text, "timed out", "timeout", "etimedout", "deadline"):
		return 504
	default:
		return 502
	}
}

func containsAny(text string, phrases ...string) bool {
	for _, phrase := range phrases {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func authenticationMessage(text string) bool {
	accessDenied := containsAny(text, "access denied", "accessdeniedexception") && containsAny(text, "authentication", "credential", "api key", "token", "signature")
	return accessDenied || containsAny(text, "authentication failed", "authentication", "invalid_api_key", "invalid api key", "invalid token", "unauthorizedexception", "unrecognizedclient", "expired token", "expiredtoken", "unauthenticated", "unauthorized")
}

func permissionMessage(text string) bool {
	return containsAny(text, "permission_denied", "permission denied", "forbidden", "access denied", "accessdeniedexception", "not allowed to use", "model access")
}
func subscriptionMessage(text string) bool {
	return containsAny(text, "requires a subscription", "requires subscription", "subscription required", "upgrade for access", "upgrade to pro", "pro subscription", "ollama.com/upgrade") || strings.Contains(text, "upgrade") && strings.Contains(text, "subscription")
}
