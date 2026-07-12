package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAppearanceStoreReturnsDefaultWithoutFile(t *testing.T) {
	store := NewAppearanceStore(filepath.Join(t.TempDir(), "config.json"))

	settings, persisted, err := store.GetAppearance()
	if err != nil {
		t.Fatalf("GetAppearance: %v", err)
	}
	if persisted {
		t.Fatalf("persisted = true, want false")
	}
	if settings != DefaultAppearanceSettings() {
		t.Fatalf("settings = %#v", settings)
	}
}

func TestAppearanceStorePersistsNormalizedSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	store := NewAppearanceStore(path)

	settings, err := store.UpdateAppearance(AppearanceSettings{
		SurfaceColor:    " #101214 ",
		ForegroundColor: "#F4F5F6",
		MutedColor:      "bad",
		AccentColor:     "#1C6417",
	})
	if err != nil {
		t.Fatalf("UpdateAppearance: %v", err)
	}
	if settings.SurfaceColor != "#101214" ||
		settings.ForegroundColor != "#f4f5f6" ||
		settings.MutedColor != DefaultAppearanceSettings().MutedColor ||
		settings.AccentColor != "#1c6417" {
		t.Fatalf("settings = %#v", settings)
	}

	rawBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(rawBytes, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, ok := raw["appearance"]; !ok {
		t.Fatalf("appearance key missing: %#v", raw)
	}

	readBack, persisted, err := store.GetAppearance()
	if err != nil {
		t.Fatalf("GetAppearance: %v", err)
	}
	if !persisted {
		t.Fatalf("persisted = false, want true")
	}
	if readBack != settings {
		t.Fatalf("readBack = %#v, want %#v", readBack, settings)
	}
}

func TestAppearanceStoreResetRemovesAppearanceOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"host":"127.0.0.1","appearance":{"accentColor":"#1c6417"}}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	store := NewAppearanceStore(path)

	settings, err := store.ResetAppearance()
	if err != nil {
		t.Fatalf("ResetAppearance: %v", err)
	}
	if settings != DefaultAppearanceSettings() {
		t.Fatalf("settings = %#v", settings)
	}

	rawBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(rawBytes, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if raw["host"] != "127.0.0.1" {
		t.Fatalf("host was not preserved: %#v", raw)
	}
	if _, ok := raw["appearance"]; ok {
		t.Fatalf("appearance still present: %#v", raw)
	}
}
