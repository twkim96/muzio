package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultHost          = "127.0.0.1"
	defaultPort          = 7777
	defaultConfigDirName = "videio_music_app"
	defaultConfigName    = "config.json"
	libraryIndexName     = "library-index.v1.log"
	progressStoreName    = "progress.v1.json"
	thumbnailCacheDir    = "thumbnails"
	thumbnailCacheV1Dir  = "v1"
)

type Config struct {
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	MediaRoots []string `json:"mediaRoots"`
	AudioRoots []string `json:"audioRoots,omitempty"`
	VideoRoots []string `json:"videoRoots,omitempty"`
	ImageRoots []string `json:"imageRoots,omitempty"`
	WebDist    string   `json:"webDist"`
}

type envLookup func(string) (string, bool)
type fileReader func(string) ([]byte, error)
type userConfigDirFunc func() (string, error)

func Default() Config {
	return Config{
		Host:       defaultHost,
		Port:       defaultPort,
		MediaRoots: nil,
	}
}

func Load(path string) (Config, error) {
	if path != "" {
		if err := recoverAtomicFile(path); err != nil {
			return Config{}, err
		}
	}
	return LoadWith(path, os.LookupEnv, os.ReadFile)
}

func LoadWith(path string, lookup envLookup, readFile fileReader) (Config, error) {
	cfg := Default()

	if path != "" {
		data, err := readFile(path)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return Config{}, fmt.Errorf("read config file: %w", err)
			}
		} else if len(data) > 0 {
			if err := json.Unmarshal(data, &cfg); err != nil {
				return Config{}, fmt.Errorf("parse config file: %w", err)
			}
		}
	}

	if value, ok := lookup("VMA_HOST"); ok {
		cfg.Host = strings.TrimSpace(value)
	}
	if value, ok := lookup("VMA_PORT"); ok {
		port, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return Config{}, fmt.Errorf("parse VMA_PORT: %w", err)
		}
		cfg.Port = port
	}
	if value, ok := lookup("VMA_MEDIA_ROOTS"); ok {
		cfg.MediaRoots = splitPathList(value)
	}
	if value, ok := lookup("VMA_WEB_DIST"); ok {
		cfg.WebDist = strings.TrimSpace(value)
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func ResolvePath(explicitPath string) (string, error) {
	return ResolvePathWith(explicitPath, os.UserConfigDir)
}

func ResolvePathWith(explicitPath string, userConfigDir userConfigDirFunc) (string, error) {
	explicitPath = strings.TrimSpace(explicitPath)
	if explicitPath != "" {
		return explicitPath, nil
	}
	dir, err := userConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(dir, defaultConfigDirName, defaultConfigName), nil
}

func ResolveLibraryIndexPath(configPath string) (string, error) {
	return resolveSiblingPath(configPath, libraryIndexName)
}

func ResolveProgressPath(configPath string) (string, error) {
	return resolveSiblingPath(configPath, progressStoreName)
}

func ResolveThumbnailCachePath(configPath string) (string, error) {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return "", errors.New("config path is required")
	}
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return "", fmt.Errorf("resolve config path: %w", err)
	}
	return filepath.Join(
		filepath.Dir(absolute),
		thumbnailCacheDir,
		thumbnailCacheV1Dir,
	), nil
}

func resolveSiblingPath(configPath, name string) (string, error) {
	configPath = strings.TrimSpace(configPath)
	if configPath == "" {
		return "", errors.New("config path is required")
	}
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return "", fmt.Errorf("resolve config path: %w", err)
	}
	return filepath.Join(filepath.Dir(absolute), name), nil
}

func UpdateMediaRoots(path string, audioRoots, videoRoots, imageRoots []string) error {
	if err := recoverAtomicFile(strings.TrimSpace(path)); err != nil {
		return err
	}
	return UpdateMediaRootsWith(path, audioRoots, videoRoots, imageRoots, os.ReadFile, atomicWriteFile)
}

func UpdateMediaRootsWith(
	path string,
	audioRoots,
	videoRoots,
	imageRoots []string,
	readFile fileReader,
	writeFile func(string, []byte, os.FileMode) error,
) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("config path is required")
	}
	path = strings.TrimSpace(path)

	raw := make(map[string]any)
	data, err := readFile(path)
	if err == nil && len(data) > 0 {
		if err := json.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("parse config file: %w", err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read config file: %w", err)
	}

	raw["audioRoots"] = cleanStringList(audioRoots)
	raw["videoRoots"] = cleanStringList(videoRoots)
	raw["imageRoots"] = cleanStringList(imageRoots)
	delete(raw, "mediaRoots")

	next, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config file: %w", err)
	}
	next = append(next, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	if err := writeFile(path, next, 0o600); err != nil {
		return fmt.Errorf("write config file: %w", err)
	}
	return nil
}

func (cfg Config) Validate() error {
	if strings.TrimSpace(cfg.Host) == "" {
		return errors.New("host is required")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535: %d", cfg.Port)
	}
	return nil
}

func (cfg Config) Address() string {
	return net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
}

func splitPathList(value string) []string {
	parts := strings.Split(value, string(os.PathListSeparator))
	roots := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			roots = append(roots, part)
		}
	}
	return roots
}

func cleanStringList(values []string) []string {
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			cleaned = append(cleaned, value)
		}
	}
	return cleaned
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}

	backupPath := path + ".bak"
	_ = os.Remove(backupPath)
	hadCurrent := false
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, backupPath); err != nil {
			return err
		}
		hadCurrent = true
		if err := syncDirectory(dir); err != nil {
			_ = os.Rename(backupPath, path)
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		if hadCurrent {
			_ = os.Rename(backupPath, path)
		}
		return err
	}
	if err := syncDirectory(dir); err != nil {
		_ = os.Remove(path)
		if hadCurrent {
			_ = os.Rename(backupPath, path)
		}
		return err
	}
	_ = os.Remove(backupPath)
	return syncDirectory(dir)
}

func syncDirectory(path string) error {
	dirHandle, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := dirHandle.Sync()
	closeErr := dirHandle.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func recoverAtomicFile(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	backupPath := path + ".bak"
	data, currentErr := os.ReadFile(path)
	currentValid := currentErr == nil && json.Valid(data)
	backupData, backupErr := os.ReadFile(backupPath)
	backupValid := backupErr == nil && json.Valid(backupData)
	switch {
	case currentValid:
		if backupErr == nil {
			_ = os.Remove(backupPath)
			return syncDirectory(filepath.Dir(path))
		}
		return nil
	case backupValid:
		_ = os.Remove(path)
		if err := os.Rename(backupPath, path); err != nil {
			return fmt.Errorf("recover config backup: %w", err)
		}
		return syncDirectory(filepath.Dir(path))
	case currentErr == nil:
		return fmt.Errorf("parse config file: invalid JSON")
	case !errors.Is(currentErr, os.ErrNotExist):
		return fmt.Errorf("read config file: %w", currentErr)
	case backupErr != nil && !errors.Is(backupErr, os.ErrNotExist):
		return fmt.Errorf("read config backup: %w", backupErr)
	default:
		return nil
	}
}
