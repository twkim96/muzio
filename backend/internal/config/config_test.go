package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadUsesDefaults(t *testing.T) {
	cfg, err := LoadWith("", emptyEnv, nil)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}

	if cfg.Host != "127.0.0.1" {
		t.Fatalf("Host = %q, want 127.0.0.1", cfg.Host)
	}
	if cfg.Port != 7777 {
		t.Fatalf("Port = %d, want 7777", cfg.Port)
	}
	if got := cfg.Address(); got != "127.0.0.1:7777" {
		t.Fatalf("Address() = %q, want 127.0.0.1:7777", got)
	}
}

func TestLoadReadsJSONConfig(t *testing.T) {
	path := writeConfig(t, `{
		"host": "0.0.0.0",
		"port": 9011,
		"mediaRoots": ["/media/legacy"],
		"audioRoots": ["/media/music"],
		"videoRoots": ["/media/video"],
		"imageRoots": ["/media/images"],
		"webDist": "/opt/muzio/web"
	}`)

	cfg, err := LoadWith(path, emptyEnv, os.ReadFile)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}

	if cfg.Host != "0.0.0.0" {
		t.Fatalf("Host = %q, want 0.0.0.0", cfg.Host)
	}
	if cfg.Port != 9011 {
		t.Fatalf("Port = %d, want 9011", cfg.Port)
	}
	wantRoots := []string{"/media/legacy"}
	if !reflect.DeepEqual(cfg.MediaRoots, wantRoots) {
		t.Fatalf("MediaRoots = %#v, want %#v", cfg.MediaRoots, wantRoots)
	}
	if !reflect.DeepEqual(cfg.AudioRoots, []string{"/media/music"}) {
		t.Fatalf("AudioRoots = %#v", cfg.AudioRoots)
	}
	if !reflect.DeepEqual(cfg.VideoRoots, []string{"/media/video"}) {
		t.Fatalf("VideoRoots = %#v", cfg.VideoRoots)
	}
	if !reflect.DeepEqual(cfg.ImageRoots, []string{"/media/images"}) {
		t.Fatalf("ImageRoots = %#v", cfg.ImageRoots)
	}
	if cfg.WebDist != "/opt/muzio/web" {
		t.Fatalf("WebDist = %q, want /opt/muzio/web", cfg.WebDist)
	}
}

func TestLoadEnvironmentOverridesConfig(t *testing.T) {
	path := writeConfig(t, `{"host": "127.0.0.1", "port": 7777}`)
	env := map[string]string{
		"VMA_HOST":        "0.0.0.0",
		"VMA_PORT":        "8181",
		"VMA_MEDIA_ROOTS": filepath.Join("media", "video") + string(os.PathListSeparator) + filepath.Join("media", "music"),
		"VMA_WEB_DIST":    filepath.Join("dist", "web"),
	}

	cfg, err := LoadWith(path, mapEnv(env), os.ReadFile)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}

	if cfg.Host != "0.0.0.0" {
		t.Fatalf("Host = %q, want 0.0.0.0", cfg.Host)
	}
	if cfg.Port != 8181 {
		t.Fatalf("Port = %d, want 8181", cfg.Port)
	}
	wantRoots := []string{filepath.Join("media", "video"), filepath.Join("media", "music")}
	if !reflect.DeepEqual(cfg.MediaRoots, wantRoots) {
		t.Fatalf("MediaRoots = %#v, want %#v", cfg.MediaRoots, wantRoots)
	}
	if cfg.WebDist != filepath.Join("dist", "web") {
		t.Fatalf("WebDist = %q, want dist/web", cfg.WebDist)
	}
}

func TestLoadMissingConfigUsesDefaultsAndEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "config.json")
	env := map[string]string{
		"VMA_PORT":        "8181",
		"VMA_MEDIA_ROOTS": filepath.Join("media", "music"),
	}

	cfg, err := LoadWith(path, mapEnv(env), os.ReadFile)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}

	if cfg.Host != "127.0.0.1" {
		t.Fatalf("Host = %q, want default", cfg.Host)
	}
	if cfg.Port != 8181 {
		t.Fatalf("Port = %d, want env override", cfg.Port)
	}
	if !reflect.DeepEqual(cfg.MediaRoots, []string{filepath.Join("media", "music")}) {
		t.Fatalf("MediaRoots = %#v", cfg.MediaRoots)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	_, err := LoadWith("", mapEnv(map[string]string{"VMA_PORT": "99999"}), nil)
	if err == nil {
		t.Fatal("LoadWith returned nil error, want invalid port error")
	}
}

func TestResolvePathUsesExplicitOrUserConfigDirectory(t *testing.T) {
	explicit, err := ResolvePathWith(" /tmp/muzio.json ", func() (string, error) {
		t.Fatal("userConfigDir should not be called for explicit paths")
		return "", nil
	})
	if err != nil {
		t.Fatalf("ResolvePathWith explicit returned error: %v", err)
	}
	if explicit != "/tmp/muzio.json" {
		t.Fatalf("explicit path = %q", explicit)
	}

	base := filepath.Join(t.TempDir(), "config-home")
	resolved, err := ResolvePathWith("", func() (string, error) {
		return base, nil
	})
	if err != nil {
		t.Fatalf("ResolvePathWith default returned error: %v", err)
	}
	want := filepath.Join(base, "videio_music_app", "config.json")
	if resolved != want {
		t.Fatalf("resolved = %q, want %q", resolved, want)
	}
}

func TestUpdateMediaRootsWritesSplitRoots(t *testing.T) {
	path := writeConfig(t, `{"host":"127.0.0.1","mediaRoots":["/old"]}`)

	if err := UpdateMediaRoots(path, []string{" /music ", ""}, []string{"/video"}, []string{"/images"}); err != nil {
		t.Fatalf("UpdateMediaRoots returned error: %v", err)
	}

	cfg, err := LoadWith(path, emptyEnv, os.ReadFile)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}
	if len(cfg.MediaRoots) != 0 {
		t.Fatalf("MediaRoots = %#v, want empty", cfg.MediaRoots)
	}
	if !reflect.DeepEqual(cfg.AudioRoots, []string{"/music"}) {
		t.Fatalf("AudioRoots = %#v", cfg.AudioRoots)
	}
	if !reflect.DeepEqual(cfg.VideoRoots, []string{"/video"}) {
		t.Fatalf("VideoRoots = %#v", cfg.VideoRoots)
	}
	if !reflect.DeepEqual(cfg.ImageRoots, []string{"/images"}) {
		t.Fatalf("ImageRoots = %#v", cfg.ImageRoots)
	}
}

func TestUpdateMediaRootsCreatesParentDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "config.json")

	if err := UpdateMediaRoots(path, []string{"/music"}, nil, nil); err != nil {
		t.Fatalf("UpdateMediaRoots returned error: %v", err)
	}

	cfg, err := LoadWith(path, emptyEnv, os.ReadFile)
	if err != nil {
		t.Fatalf("LoadWith returned error: %v", err)
	}
	if !reflect.DeepEqual(cfg.AudioRoots, []string{"/music"}) {
		t.Fatalf("AudioRoots = %#v", cfg.AudioRoots)
	}
}

func TestLoadRecoversAtomicConfigBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"host":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		path+".bak",
		[]byte(`{"host":"127.0.0.1","port":7777}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != 7777 {
		t.Fatalf("recovered config = %#v", cfg)
	}
	if _, err := os.Stat(path + ".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup still exists: %v", err)
	}
}

func TestResolveLibraryIndexPathNextToConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "nested", "config.json")
	got, err := ResolveLibraryIndexPath(configPath)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(configPath), libraryIndexName)
	if got != want {
		t.Fatalf("ResolveLibraryIndexPath = %q, want %q", got, want)
	}
}

func TestResolveProgressPathNextToConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "nested", "config.json")
	got, err := ResolveProgressPath(configPath)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(configPath), progressStoreName)
	if got != want {
		t.Fatalf("ResolveProgressPath = %q, want %q", got, want)
	}
}

func TestResolveThumbnailCachePathNextToConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "nested", "config.json")
	got, err := ResolveThumbnailCachePath(configPath)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(filepath.Dir(configPath), "thumbnails", "v1")
	if got != want {
		t.Fatalf("ResolveThumbnailCachePath = %q, want %q", got, want)
	}
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func emptyEnv(string) (string, bool) {
	return "", false
}

func mapEnv(values map[string]string) envLookup {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
