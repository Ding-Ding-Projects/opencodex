package lib

import "testing"

func TestErrorClassificationAndFormatting(t *testing.T) {
	classified := ClassifyError(401, "permission_error", "authentication failed; upgrade subscription")
	if classified.Type != "authentication_error" || classified.Code == nil || *classified.Code != "invalid_api_key" {
		t.Fatalf("classified = %#v", classified)
	}
	if got := InferHTTPStatus("client closed request during web-search"); got != 499 {
		t.Fatalf("status = %d", got)
	}
	if seconds, ok := ParseRetryAfterFromMessage("retry after 1.2 seconds"); !ok || seconds != 2 {
		t.Fatalf("retry = %d, %v", seconds, ok)
	}
}
