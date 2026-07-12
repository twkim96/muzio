package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type AppearanceSettings struct {
	SurfaceColor    string `json:"surfaceColor"`
	ForegroundColor string `json:"foregroundColor"`
	MutedColor      string `json:"mutedColor"`
	AccentColor     string `json:"accentColor"`
}

type AppearanceStore struct {
	Path string
}

var hexColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func DefaultAppearanceSettings() AppearanceSettings {
	return AppearanceSettings{
		SurfaceColor:    "#1f1f1f",
		ForegroundColor: "#ededed",
		MutedColor:      "#aeaeae",
		AccentColor:     "#fa2d48",
	}
}

func NewAppearanceStore(path string) AppearanceStore {
	return AppearanceStore{Path: strings.TrimSpace(path)}
}

func (s AppearanceStore) GetAppearance() (AppearanceSettings, bool, error) {
	raw, err := readConfigObject(s.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return DefaultAppearanceSettings(), false, nil
		}
		return AppearanceSettings{}, false, err
	}
	appearance, ok := raw["appearance"]
	if !ok {
		return DefaultAppearanceSettings(), false, nil
	}
	return NormalizeAppearanceSettings(appearance), true, nil
}

func (s AppearanceStore) UpdateAppearance(settings AppearanceSettings) (AppearanceSettings, error) {
	if s.Path == "" {
		return AppearanceSettings{}, errors.New("config path is required")
	}
	raw, err := readConfigObject(s.Path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return AppearanceSettings{}, err
	}
	next := NormalizeAppearanceSettings(settings)
	raw["appearance"] = next
	if err := writeConfigObject(s.Path, raw); err != nil {
		return AppearanceSettings{}, err
	}
	return next, nil
}

func (s AppearanceStore) ResetAppearance() (AppearanceSettings, error) {
	if s.Path == "" {
		return AppearanceSettings{}, errors.New("config path is required")
	}
	raw, err := readConfigObject(s.Path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return AppearanceSettings{}, err
	}
	delete(raw, "appearance")
	if err := writeConfigObject(s.Path, raw); err != nil {
		return AppearanceSettings{}, err
	}
	return DefaultAppearanceSettings(), nil
}

func NormalizeAppearanceSettings(payload any) AppearanceSettings {
	defaults := DefaultAppearanceSettings()
	if payload == nil {
		return defaults
	}
	switch value := payload.(type) {
	case AppearanceSettings:
		return AppearanceSettings{
			SurfaceColor:    normalizeHexColor(value.SurfaceColor, defaults.SurfaceColor),
			ForegroundColor: normalizeHexColor(value.ForegroundColor, defaults.ForegroundColor),
			MutedColor:      normalizeHexColor(value.MutedColor, defaults.MutedColor),
			AccentColor:     normalizeHexColor(value.AccentColor, defaults.AccentColor),
		}
	case map[string]any:
		return AppearanceSettings{
			SurfaceColor:    normalizeHexColor(stringValue(value["surfaceColor"]), defaults.SurfaceColor),
			ForegroundColor: normalizeHexColor(stringValue(value["foregroundColor"]), defaults.ForegroundColor),
			MutedColor:      normalizeHexColor(stringValue(value["mutedColor"]), defaults.MutedColor),
			AccentColor:     normalizeHexColor(stringValue(value["accentColor"]), defaults.AccentColor),
		}
	default:
		return defaults
	}
}

func readConfigObject(path string) (map[string]any, error) {
	if strings.TrimSpace(path) == "" {
		return map[string]any{}, os.ErrNotExist
	}
	if err := recoverAtomicFile(path); err != nil {
		return map[string]any{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}, err
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	raw := make(map[string]any)
	if err := json.Unmarshal(data, &raw); err != nil {
		return map[string]any{}, fmt.Errorf("parse config file: %w", err)
	}
	return raw, nil
}

func writeConfigObject(path string, raw map[string]any) error {
	next, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config file: %w", err)
	}
	next = append(next, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	if err := atomicWriteFile(path, next, 0o600); err != nil {
		return fmt.Errorf("write config file: %w", err)
	}
	return nil
}

func normalizeHexColor(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if hexColorPattern.MatchString(value) {
		return strings.ToLower(value)
	}
	return fallback
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
