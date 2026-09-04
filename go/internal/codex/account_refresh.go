package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	refreshSkew      = time.Minute
	refreshLockStale = time.Minute
	chatGPTTokenURL  = "https://auth.openai.com/oauth/token"
	chatGPTClientID  = "app_EMoamEEZ73f0CkXaXp7hrann"
)

type TokenRefreshReason string

const (
	TokenRefreshExpired TokenRefreshReason = "expired"
	TokenRefreshRevoked TokenRefreshReason = "revoked"
	TokenRefreshUnknown TokenRefreshReason = "unknown"
)

type TokenRefreshError struct {
	Reason TokenRefreshReason
}

func (e *TokenRefreshError) Error() string {
	return fmt.Sprintf("Codex token refresh failed (%s); reauthenticate the account", e.Reason)
}

var (
	ErrCredentialGenerationConflict = errors.New("Codex account changed during refresh")
	ErrCredentialRefreshLockTimeout = errors.New("timed out waiting for Codex account refresh lock")
)

type ValidToken struct {
	AccessToken      string
	ChatGPTAccountID string
	Generation       int64
}

type refreshResult struct {
	ValidToken
	Credential *AccountCredentials
}

type refreshCall struct {
	done   chan struct{}
	result refreshResult
	err    error
}

var refreshFlights = struct {
	sync.Mutex
	calls map[string]*refreshCall
}{calls: make(map[string]*refreshCall)}

func (s *AccountStore) GetValidToken(ctx context.Context, id string, client *http.Client) (ValidToken, error) {
	record, ok, err := s.ReadRecord(id)
	if err != nil {
		return ValidToken{}, err
	}
	if !ok || record.DeletedAt != nil || record.Credential == nil {
		return ValidToken{}, errors.New("Codex account credential is unavailable; reauthenticate the account")
	}
	credential := *record.Credential
	fingerprint := record.RefreshGrantFingerprint
	if fingerprint == "" {
		fingerprint = RefreshGrantFingerprint(credential.RefreshToken)
	}
	if credential.ExpiresAt > s.now().Add(refreshSkew).UnixMilli() {
		return ValidToken{credential.AccessToken, credential.ChatGPTAccountID, record.Generation}, nil
	}
	flightKey := s.path + "\x00" + fingerprint

	refreshFlights.Lock()
	if existing := refreshFlights.calls[flightKey]; existing != nil {
		refreshFlights.Unlock()
		select {
		case <-ctx.Done():
			return ValidToken{}, ctx.Err()
		case <-existing.done:
		}
		if existing.err != nil {
			return ValidToken{}, existing.err
		}
		if existing.result.Credential != nil {
			current, live, readErr := s.ReadRecord(id)
			if readErr != nil {
				return ValidToken{}, readErr
			}
			if live && current.DeletedAt == nil && current.Credential != nil && current.RefreshGrantFingerprint == fingerprint {
				saved, saveErr := s.SaveCredentialIfGeneration(id, current.Generation, *existing.result.Credential)
				if saveErr != nil {
					return ValidToken{}, saveErr
				}
				if !saved {
					return ValidToken{}, ErrCredentialGenerationConflict
				}
				return ValidToken{existing.result.Credential.AccessToken, existing.result.Credential.ChatGPTAccountID, current.Generation + 1}, nil
			}
		}
		return s.GetValidToken(ctx, id, client)
	}
	call := &refreshCall{done: make(chan struct{})}
	refreshFlights.calls[flightKey] = call
	refreshFlights.Unlock()

	call.result, call.err = s.refreshToken(ctx, id, fingerprint, client)
	refreshFlights.Lock()
	delete(refreshFlights.calls, flightKey)
	close(call.done)
	refreshFlights.Unlock()
	return call.result.ValidToken, call.err
}

func (s *AccountStore) refreshToken(ctx context.Context, id, fingerprint string, client *http.Client) (refreshResult, error) {
	lockPath := filepath.Join(filepath.Dir(s.path), fmt.Sprintf("codex-refresh-%s.lock", fingerprint[:32]))
	release, err := acquireCodexRefreshLock(ctx, lockPath, s.now)
	if err != nil {
		return refreshResult{}, err
	}
	defer release()

	record, ok, err := s.ReadRecord(id)
	if err != nil {
		return refreshResult{}, err
	}
	if !ok || record.DeletedAt != nil || record.Credential == nil {
		return refreshResult{}, ErrCredentialGenerationConflict
	}
	credential := *record.Credential
	startGeneration := record.Generation
	lockedFingerprint := record.RefreshGrantFingerprint
	if lockedFingerprint == "" {
		lockedFingerprint = RefreshGrantFingerprint(credential.RefreshToken)
	}
	if lockedFingerprint != fingerprint {
		if credential.ExpiresAt > s.now().Add(refreshSkew).UnixMilli() {
			return refreshResult{ValidToken{credential.AccessToken, credential.ChatGPTAccountID, startGeneration}, &credential}, nil
		}
		return refreshResult{}, ErrCredentialGenerationConflict
	}
	if credential.ExpiresAt > s.now().Add(refreshSkew).UnixMilli() {
		return refreshResult{ValidToken{credential.AccessToken, credential.ChatGPTAccountID, startGeneration}, &credential}, nil
	}
	if shared, found, findErr := s.findFreshCredentialForGrant(fingerprint, id); findErr != nil {
		return refreshResult{}, findErr
	} else if found {
		saved, saveErr := s.SaveCredentialIfGeneration(id, startGeneration, shared)
		if saveErr != nil || !saved {
			if saveErr != nil {
				return refreshResult{}, saveErr
			}
			return refreshResult{}, ErrCredentialGenerationConflict
		}
		return refreshResult{ValidToken{shared.AccessToken, shared.ChatGPTAccountID, startGeneration + 1}, &shared}, nil
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {chatGPTClientID}, "refresh_token": {credential.RefreshToken}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, chatGPTTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return refreshResult{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		return refreshResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16<<10))
		return refreshResult{}, classifyTokenRefreshError(body)
	}
	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return refreshResult{}, fmt.Errorf("decode Codex token refresh response: %w", err)
	}
	if payload.AccessToken == "" || payload.ExpiresIn <= 0 {
		return refreshResult{}, errors.New("Codex token refresh returned an invalid credential")
	}
	if payload.RefreshToken == "" {
		payload.RefreshToken = credential.RefreshToken
	}
	updated := AccountCredentials{payload.AccessToken, payload.RefreshToken, s.now().UnixMilli() + payload.ExpiresIn*1000, credential.ChatGPTAccountID}
	saved, err := s.SaveCredentialIfGeneration(id, startGeneration, updated)
	if err != nil {
		return refreshResult{}, err
	}
	if !saved {
		return refreshResult{}, ErrCredentialGenerationConflict
	}
	return refreshResult{ValidToken{updated.AccessToken, updated.ChatGPTAccountID, startGeneration + 1}, &updated}, nil
}

func (s *AccountStore) findFreshCredentialForGrant(fingerprint, excludeID string) (AccountCredentials, bool, error) {
	records, err := s.loadRecords()
	if err != nil {
		return AccountCredentials{}, false, err
	}
	threshold := s.now().Add(refreshSkew).UnixMilli()
	for id, record := range records {
		if id == excludeID || record.DeletedAt != nil || record.Credential == nil {
			continue
		}
		candidateFingerprint := record.RefreshGrantFingerprint
		if candidateFingerprint == "" {
			candidateFingerprint = RefreshGrantFingerprint(record.Credential.RefreshToken)
		}
		if candidateFingerprint == fingerprint && record.Credential.ExpiresAt > threshold {
			return *record.Credential, true, nil
		}
	}
	return AccountCredentials{}, false, nil
}

func classifyTokenRefreshError(body []byte) error {
	text := strings.ToLower(string(body))
	var payload struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if json.Unmarshal(body, &payload) == nil {
		text = strings.ToLower(payload.Error + ": " + payload.ErrorDescription)
	}
	reason := TokenRefreshUnknown
	if strings.Contains(text, "invalidated") || strings.Contains(text, "revoked") {
		reason = TokenRefreshRevoked
	} else if strings.Contains(text, "expired") {
		reason = TokenRefreshExpired
	}
	return &TokenRefreshError{Reason: reason}
}

func acquireCodexRefreshLock(ctx context.Context, path string, now func() time.Time) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	deadline := now().Add(refreshLockStale + 5*time.Second)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = json.NewEncoder(file).Encode(map[string]any{"acquiredAt": now().UnixMilli(), "pid": os.Getpid()})
			_ = file.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if codexRefreshLockStale(path, now()) {
			_ = os.Remove(path)
			continue
		}
		if !now().Before(deadline) {
			return nil, ErrCredentialRefreshLockTimeout
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func codexRefreshLockStale(path string, now time.Time) bool {
	file, err := os.Open(path)
	if err != nil {
		return true
	}
	defer file.Close()
	var metadata struct {
		AcquiredAt int64 `json:"acquiredAt"`
	}
	if json.NewDecoder(io.LimitReader(file, 4096)).Decode(&metadata) != nil || metadata.AcquiredAt == 0 {
		return true
	}
	return now.UnixMilli()-metadata.AcquiredAt > refreshLockStale.Milliseconds()
}
