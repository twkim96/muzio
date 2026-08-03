package library

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"muzio/backend/internal/mediapath"
)

// junkBaseNames are files commonly created by operating systems and tools
// that should never appear in a media listing regardless of extension.
var junkBaseNames = map[string]struct{}{
	".ds_store":   {},
	"thumbs.db":   {},
	"desktop.ini": {},
}

var skippedDirNames = map[string]struct{}{
	"node_modules": {},
}

// Scan walks every configured root once and returns the media records that
// pass classification and safety checks. Missing roots and unreadable files
// are logged and skipped rather than failing the whole scan, so a single
// misconfigured root cannot block the rest of the library from loading.
func Scan(roots *mediapath.Roots, logger *slog.Logger) ([]Media, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if roots == nil {
		return nil, nil
	}

	return scanRoots(roots, nil, logger)
}

type mediaTypeSet map[MediaType]struct{}

type RootScanResult struct {
	Root        mediapath.Root
	Items       []Media
	Complete    bool
	Unavailable bool
	Err         error
}

func (set mediaTypeSet) allows(mediaType MediaType) bool {
	if set == nil {
		return true
	}
	_, ok := set[mediaType]
	return ok
}

func scanMediaRootSettings(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []Media, error) {
	roots, results, err := scanMediaRootSettingsReport(settings, logger)
	if err != nil {
		return nil, nil, err
	}
	return roots, flattenRootScanResults(results), nil
}

func scanMediaRootSettingsReport(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
	return scanMediaRootSettingsReportContext(context.Background(), settings, logger, nil)
}

func scanMediaRootSettingsReportContext(
	ctx context.Context,
	settings MediaRootSettings,
	logger *slog.Logger,
	beforeRoot func(context.Context, bool) error,
) (*mediapath.Roots, []RootScanResult, error) {
	allowedByPath, paths, err := mediaRootTypeMap(settings)
	if err != nil {
		return nil, nil, err
	}
	roots, err := mediapath.NewRoots(paths)
	if err != nil {
		return nil, nil, err
	}
	results, err := scanRootResultsContext(ctx, roots, allowedByPath, logger, beforeRoot)
	return roots, results, err
}

func mediaRootTypeMap(settings MediaRootSettings) (map[string]mediaTypeSet, []string, error) {
	allowedByPath := make(map[string]mediaTypeSet)
	var paths []string

	addRoots := func(mediaType MediaType, roots []string) error {
		for _, root := range roots {
			cleaned, err := normalizeRootPath(root)
			if err != nil {
				return err
			}
			if cleaned == "" {
				continue
			}
			if _, ok := allowedByPath[cleaned]; !ok {
				allowedByPath[cleaned] = make(mediaTypeSet)
				paths = append(paths, cleaned)
			}
			allowedByPath[cleaned][mediaType] = struct{}{}
		}
		return nil
	}

	if err := addRoots(MediaTypeAudio, settings.AudioRoots); err != nil {
		return nil, nil, err
	}
	if err := addRoots(MediaTypeVideo, settings.VideoRoots); err != nil {
		return nil, nil, err
	}
	if err := addRoots(MediaTypeImage, settings.ImageRoots); err != nil {
		return nil, nil, err
	}

	return allowedByPath, paths, nil
}

func normalizeRootPath(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", nil
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", fmt.Errorf("mediapath: resolve %q: %w", trimmed, err)
	}
	return filepath.Clean(abs), nil
}

func scanRoots(roots *mediapath.Roots, allowedByPath map[string]mediaTypeSet, logger *slog.Logger) ([]Media, error) {
	return flattenRootScanResults(scanRootResults(roots, allowedByPath, logger)), nil
}

func scanRootResults(roots *mediapath.Roots, allowedByPath map[string]mediaTypeSet, logger *slog.Logger) []RootScanResult {
	results, _ := scanRootResultsContext(context.Background(), roots, allowedByPath, logger, nil)
	return results
}

func scanRootResultsContext(
	ctx context.Context,
	roots *mediapath.Roots,
	allowedByPath map[string]mediaTypeSet,
	logger *slog.Logger,
	beforeRoot func(context.Context, bool) error,
) ([]RootScanResult, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if roots == nil {
		return nil, nil
	}

	results := make([]RootScanResult, 0, len(roots.All()))
	for index, root := range roots.All() {
		if beforeRoot != nil {
			if err := beforeRoot(ctx, index == 0); err != nil {
				return results, err
			}
		}
		if err := ctx.Err(); err != nil {
			return results, err
		}
		result := RootScanResult{Root: root}
		startedAt := time.Now()
		info, err := os.Stat(root.Path)
		if err != nil {
			result.Err = err
			result.Unavailable = true
			if errors.Is(err, fs.ErrNotExist) {
				logger.Warn("media root missing, skipping", "name", root.Name, "path", root.Path)
			} else {
				logger.Warn("media root not accessible, skipping", "name", root.Name, "path", root.Path, "error", err)
			}
			results = append(results, result)
			continue
		}
		if !info.IsDir() {
			result.Err = fmt.Errorf("media root is not a directory: %s", root.Path)
			result.Unavailable = true
			logger.Warn("media root is not a directory, skipping", "name", root.Name, "path", root.Path)
			results = append(results, result)
			continue
		}
		directory, err := os.Open(root.Path)
		if err != nil {
			result.Err = err
			result.Unavailable = true
			logger.Warn("media root cannot be opened, skipping", "name", root.Name, "path", root.Path, "error", err)
			results = append(results, result)
			continue
		}
		_, readErr := directory.Readdirnames(1)
		closeErr := directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			result.Err = readErr
			result.Unavailable = true
			logger.Warn("media root cannot be read, skipping", "name", root.Name, "path", root.Path, "error", readErr)
			results = append(results, result)
			continue
		}
		if closeErr != nil {
			logger.Warn("media root close failed", "name", root.Name, "path", root.Path, "error", closeErr)
		}

		rootItems, complete, err := scanRootContext(
			ctx,
			root,
			allowedByPath[root.Path],
			logger,
			beforeRoot,
		)
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return results, err
		}
		result.Items = rootItems
		result.Complete = complete
		result.Err = err
		if err != nil {
			logger.Warn("media root scan incomplete", "name", root.Name, "error", err)
		}
		logger.Info(
			"media root scan complete",
			"name", root.Name,
			"path", root.Path,
			"items", len(rootItems),
			"complete", complete,
			"duration", time.Since(startedAt),
		)
		results = append(results, result)
	}
	return results, nil
}

func flattenRootScanResults(results []RootScanResult) []Media {
	var items []Media
	for _, result := range results {
		items = append(items, result.Items...)
	}
	return items
}

func scanRootContext(
	ctx context.Context,
	root mediapath.Root,
	allowedTypes mediaTypeSet,
	logger *slog.Logger,
	pause func(context.Context, bool) error,
) ([]Media, bool, error) {
	return scanTreeContext(ctx, root, root.Path, allowedTypes, logger, pause)
}

func scanTreeContext(
	ctx context.Context,
	root mediapath.Root,
	startPath string,
	allowedTypes mediaTypeSet,
	logger *slog.Logger,
	pause func(context.Context, bool) error,
) ([]Media, bool, error) {
	var items []Media
	var mediaPaths []string
	subtitlesByDir := make(map[string]*subtitleCandidateIndex)
	complete := true
	var incompleteErr error
	markIncomplete := func(err error) {
		complete = false
		if incompleteErr == nil {
			incompleteErr = err
		}
	}

	visited := 0
	walkErr := filepath.WalkDir(startPath, func(path string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		visited++
		if pause != nil && visited%128 == 0 {
			if pauseErr := pause(ctx, false); pauseErr != nil {
				return pauseErr
			}
		}
		if err != nil {
			markIncomplete(err)
			logger.Warn("walk error, skipping entry", "path", path, "error", err)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		name := d.Name()

		if d.IsDir() {
			if path == startPath {
				return nil
			}
			if shouldSkipDir(name) {
				return fs.SkipDir
			}
			return nil
		}

		if !d.Type().IsRegular() {
			// Skip symlinks, devices, sockets. WalkDir does not follow symlinks
			// to directories, so a symlink to a folder ends up here as a non-dir
			// entry and is dropped.
			return nil
		}
		if shouldSkipFile(name) {
			return nil
		}
		if isSubtitleFile(name) {
			dir := filepath.Dir(path)
			rel, err := filepath.Rel(root.Path, path)
			if err != nil {
				return nil
			}
			index := subtitlesByDir[dir]
			if index == nil {
				index = &subtitleCandidateIndex{}
				subtitlesByDir[dir] = index
			}
			index.add(subtitleCandidate{
				name:         name,
				relativePath: filepath.ToSlash(rel),
			})
			return nil
		}

		mediaType, ok := classifyExt(name)
		if !ok {
			return nil
		}
		if !allowedTypes.allows(mediaType) {
			return nil
		}
		if strings.EqualFold(filepath.Ext(name), ".ts") &&
			!looksLikeMPEGTransportStream(path) {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			markIncomplete(err)
			logger.Warn("stat failed, skipping file", "path", path, "error", err)
			return nil
		}

		rel, err := filepath.Rel(root.Path, path)
		if err != nil {
			markIncomplete(err)
			logger.Warn("relative path failed, skipping file", "path", path, "error", err)
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		id := mediapath.EncodeID(root.Name, relSlash)
		metadata := EnrichMetadataFromFile(
			path,
			mediaType,
			ExtractMetadata(mediaType, relSlash, name),
		)
		modifiedAt := info.ModTime().UTC()
		mimeType, _ := MIMEFor(name)

		items = append(items, Media{
			ID:           id,
			Type:         mediaType,
			RootName:     root.Name,
			RelativePath: relSlash,
			Name:         name,
			MIMEType:     mimeType,
			SizeBytes:    info.Size(),
			ModifiedAt:   modifiedAt,
			Metadata:     metadata,
			Thumbnail:    BuildThumbnail(id, mediaType, metadata, modifiedAt, info.Size()),
		})
		mediaPaths = append(mediaPaths, path)
		return nil
	})
	if walkErr != nil {
		if errors.Is(walkErr, context.Canceled) || errors.Is(walkErr, context.DeadlineExceeded) {
			return items, false, walkErr
		}
		markIncomplete(walkErr)
		return items, false, incompleteErr
	}
	for i, mediaPath := range mediaPaths {
		if i%128 == 0 {
			if err := ctx.Err(); err != nil {
				return items, false, err
			}
			if pause != nil {
				if err := pause(ctx, false); err != nil {
					return items, false, err
				}
			}
		}
		if index := subtitlesByDir[filepath.Dir(mediaPath)]; index != nil {
			index.addMediaPath(mediaPath)
		}
	}
	for _, index := range subtitlesByDir {
		if err := index.buildContext(ctx, pause); err != nil {
			return items, false, err
		}
	}
	for i, mediaPath := range mediaPaths {
		if i%16 == 0 {
			if err := ctx.Err(); err != nil {
				return items, false, err
			}
			if pause != nil {
				if err := pause(ctx, false); err != nil {
					return items, false, err
				}
			}
		}
		subtitles, err := subtitlesFromCandidateIndexContext(
			ctx,
			mediaPath,
			subtitlesByDir[filepath.Dir(mediaPath)],
			pause,
		)
		if err != nil {
			return items, false, err
		}
		items[i].Subtitles = subtitles
	}
	return items, complete, incompleteErr
}

func scanMediaFile(
	root mediapath.Root,
	path string,
	allowedTypes mediaTypeSet,
) (Media, bool, error) {
	name := filepath.Base(path)
	if shouldSkipFile(name) {
		return Media{}, false, nil
	}
	mediaType, ok := classifyExt(name)
	if !ok || !allowedTypes.allows(mediaType) {
		return Media{}, false, nil
	}
	if strings.EqualFold(filepath.Ext(name), ".ts") &&
		!looksLikeMPEGTransportStream(path) {
		return Media{}, false, nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return Media{}, false, err
	}
	if !info.Mode().IsRegular() {
		return Media{}, false, nil
	}
	relativePath, err := filepath.Rel(root.Path, path)
	if err != nil {
		return Media{}, false, err
	}
	relativePath = filepath.ToSlash(relativePath)
	id := mediapath.EncodeID(root.Name, relativePath)
	metadata := EnrichMetadataFromFile(
		path,
		mediaType,
		ExtractMetadata(mediaType, relativePath, name),
	)
	modifiedAt := info.ModTime().UTC()
	mimeType, _ := MIMEFor(name)
	return Media{
		ID:           id,
		Type:         mediaType,
		RootName:     root.Name,
		RelativePath: relativePath,
		Name:         name,
		MIMEType:     mimeType,
		SizeBytes:    info.Size(),
		ModifiedAt:   modifiedAt,
		Metadata:     metadata,
		Thumbnail:    BuildThumbnail(id, mediaType, metadata, modifiedAt, info.Size()),
	}, true, nil
}

func shouldSkipDir(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasPrefix(name, ".") {
		return true
	}
	if _, ok := skippedDirNames[strings.ToLower(name)]; ok {
		return true
	}
	return false
}

func looksLikeMPEGTransportStream(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()

	const sampleSize = 5 * 204
	sample := make([]byte, sampleSize)
	n, err := io.ReadFull(file, sample)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	sample = sample[:n]

	for _, packetSize := range []int{188, 192, 204} {
		for offset := 0; offset < packetSize && offset+2*packetSize < len(sample); offset++ {
			if sample[offset] == 0x47 &&
				sample[offset+packetSize] == 0x47 &&
				sample[offset+2*packetSize] == 0x47 {
				return true
			}
		}
	}
	return false
}

func shouldSkipFile(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasPrefix(name, ".") {
		return true
	}
	if _, ok := junkBaseNames[strings.ToLower(name)]; ok {
		return true
	}
	return false
}
