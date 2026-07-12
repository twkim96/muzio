package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"muzio/backend/internal/config"
	"muzio/backend/internal/library"
)

type stubAppearanceManager struct {
	items      []library.Media
	settings   config.AppearanceSettings
	persisted  bool
	updated    bool
	reset      bool
	updateBody config.AppearanceSettings
}

func (s *stubAppearanceManager) List(filter library.MediaType) []library.Media {
	return s.items
}

func (s *stubAppearanceManager) GetAppearance() (config.AppearanceSettings, bool, error) {
	return s.settings, s.persisted, nil
}

func (s *stubAppearanceManager) UpdateAppearance(settings config.AppearanceSettings) (config.AppearanceSettings, error) {
	s.updated = true
	s.updateBody = settings
	s.settings = config.NormalizeAppearanceSettings(settings)
	s.persisted = true
	return s.settings, nil
}

func (s *stubAppearanceManager) ResetAppearance() (config.AppearanceSettings, error) {
	s.reset = true
	s.settings = config.DefaultAppearanceSettings()
	s.persisted = false
	return s.settings, nil
}

func TestAppearanceGetReturnsCurrentSettings(t *testing.T) {
	manager := &stubAppearanceManager{
		settings: config.AppearanceSettings{
			SurfaceColor:    "#101214",
			ForegroundColor: "#f4f5f6",
			MutedColor:      "#a1a7ad",
			AccentColor:     "#1c6417",
		},
		persisted: true,
	}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/settings/appearance", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body appearanceResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Persisted || body.Settings.AccentColor != "#1c6417" {
		t.Fatalf("body = %#v", body)
	}
}

func TestAppearancePutUpdatesSettings(t *testing.T) {
	manager := &stubAppearanceManager{}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)
	body := bytes.NewBufferString(`{"settings":{"surfaceColor":"#101214","foregroundColor":"#f4f5f6","mutedColor":"#a1a7ad","accentColor":"#1c6417"}}`)

	req := httptest.NewRequest(http.MethodPut, "/api/settings/appearance", body)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !manager.updated || manager.updateBody.AccentColor != "#1c6417" {
		t.Fatalf("manager = %#v", manager)
	}
	var response appearanceResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !response.Persisted || response.Settings.SurfaceColor != "#101214" {
		t.Fatalf("response = %#v", response)
	}
}

func TestAppearanceDeleteResetsSettings(t *testing.T) {
	manager := &stubAppearanceManager{
		settings:  config.AppearanceSettings{AccentColor: "#1c6417"},
		persisted: true,
	}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)

	req := httptest.NewRequest(http.MethodDelete, "/api/settings/appearance", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !manager.reset {
		t.Fatalf("ResetAppearance was not called")
	}
	var response appearanceResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Persisted || response.Settings != config.DefaultAppearanceSettings() {
		t.Fatalf("response = %#v", response)
	}
}
