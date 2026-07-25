package server

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageEditsRelaysMultipartBodyByteIdentically(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("model", "gpt-image-1")
	part, err := writer.CreateFormFile("image", "reference.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte{0x89, 'P', 'N', 'G', 0, 1, 2, 3})
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	original := append([]byte(nil), body.Bytes()...)
	contentType := writer.FormDataContentType()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		got, _ := io.ReadAll(request.Body)
		if request.Header.Get("Content-Type") != contentType {
			t.Errorf("content-type = %q", request.Header.Get("Content-Type"))
		}
		if !bytes.Equal(got, original) {
			t.Errorf("multipart body changed: got %d bytes want %d", len(got), len(original))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"b64_json":"ok"}]}`)
	}))
	defer upstream.Close()

	handler := sidecarHandler(SidecarImageEdits, func(_ context.Context, _ SidecarKind, _ http.Header) (SidecarTarget, error) {
		return SidecarTarget{URL: upstream.URL, Transport: upstream.Client()}, nil
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/images/edits", bytes.NewReader(original))
	request.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "b64_json") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestMultipartRemainsRestrictedToImageEdits(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader("--boundary--"))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=boundary")
	response := httptest.NewRecorder()
	handler := sidecarHandler(SidecarImageGenerations, func(_ context.Context, _ SidecarKind, _ http.Header) (SidecarTarget, error) {
		t.Fatal("resolver should not run for malformed generation body")
		return SidecarTarget{}, nil
	})
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "valid JSON") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
