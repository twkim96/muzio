package library

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"muzio/backend/internal/mediapath"
)

func (s *Service) reconcileWatchPath(ctx context.Context, changedPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	changedPath = filepath.Clean(changedPath)

	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		retry, err := s.reconcileWatchPathAttempt(ctx, changedPath)
		if err != nil || !retry {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := s.RescanMediaRoots()
	return err
}

func (s *Service) reconcileWatchPathAttempt(
	ctx context.Context,
	changedPath string,
) (bool, error) {
	s.mu.RLock()
	roots := s.roots
	settings := cloneSettings(s.settings)
	snapshot := s.snapshot
	s.mu.RUnlock()
	if roots == nil || snapshot == nil {
		return false, nil
	}

	root, ok := rootForWatchPath(roots.All(), changedPath)
	if !ok || hiddenWatchPath(root.Path, changedPath) {
		return false, nil
	}
	if !roots.RootAvailable(root.Name) {
		_, err := s.RescanMediaRoots()
		return false, err
	}
	allowedByPath, _, err := mediaRootTypeMap(settings)
	if err != nil {
		return false, err
	}

	s.scans.workerMu.Lock()
	defer s.scans.workerMu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}

	baseRevision := snapshot.Revision()
	target := changedPath
	var items []Media
	complete := false
	var scanErr error
	info, statErr := os.Stat(target)
	if statErr == nil && !info.IsDir() {
		relativePath, relativeErr := filepath.Rel(root.Path, target)
		if relativeErr != nil {
			return false, relativeErr
		}
		previous, previousErr := snapshot.GetByPath(
			root.Name,
			filepath.ToSlash(relativePath),
		)
		if previousErr == nil {
			item, ok, err := scanMediaFile(root, target, allowedByPath[root.Path])
			if err != nil {
				return false, err
			}
			if ok && item.ID == previous.ID && item.Type == previous.Type {
				item.Subtitles = append([]Subtitle(nil), previous.Subtitles...)
				items = []Media{item}
			} else {
				target = filepath.Dir(target)
			}
		} else if errors.Is(previousErr, ErrNotFound) {
			target = filepath.Dir(target)
		} else {
			return false, previousErr
		}
	} else if errors.Is(statErr, os.ErrNotExist) {
		target = filepath.Dir(target)
	} else if statErr != nil {
		return false, statErr
	}
	for target != root.Path {
		info, err = os.Stat(target)
		if err == nil && info.IsDir() {
			break
		}
		parent := filepath.Dir(target)
		if parent == target {
			return false, nil
		}
		target = parent
	}
	if !pathWithinRoot(root.Path, target) {
		return false, nil
	}

	if len(items) == 0 {
		items, complete, scanErr = scanTreeContext(
			ctx,
			root,
			target,
			allowedByPath[root.Path],
			s.logger,
			s.waitBeforeScanRoot,
		)
	}
	if errors.Is(scanErr, context.Canceled) || errors.Is(scanErr, context.DeadlineExceeded) {
		return false, scanErr
	}

	s.updateMu.Lock()
	defer s.updateMu.Unlock()
	s.mu.RLock()
	currentSnapshot := s.snapshot
	currentRoots := s.roots
	s.mu.RUnlock()
	if currentSnapshot != snapshot || currentRoots == nil {
		return true, nil
	}
	currentRoot, stillConfigured := currentRoots.ByName(root.Name)
	if !stillConfigured || currentRoot.Path != root.Path {
		return false, nil
	}
	items = preserveRuntimeMediaFields(currentSnapshot, items)

	protected := make(map[string]struct{})
	if currentSnapshot.Revision() != baseRevision {
		changes := currentSnapshot.ChangesSince(baseRevision, "")
		if changes.ResetRequired {
			complete = false
		} else {
			for _, item := range changes.Upserts {
				protected[item.ID] = struct{}{}
			}
		}
	}
	scannedIDs := make(map[string]struct{}, len(items))
	for _, item := range items {
		scannedIDs[item.ID] = struct{}{}
	}
	var deletedIDs []string
	if complete {
		for _, previous := range currentSnapshot.ListRoot(root.Name) {
			if !mediaInsideWatchTree(previous, root.Path, target) {
				continue
			}
			if _, exists := scannedIDs[previous.ID]; exists {
				continue
			}
			if _, changedConcurrently := protected[previous.ID]; changedConcurrently {
				continue
			}
			deletedIDs = append(deletedIDs, previous.ID)
		}
	}
	result := s.applyChangesLocked(items, deletedIDs, "watch")
	if result.Added+result.Updated+result.Removed > 0 {
		s.logger.Info(
			"filesystem changes reconciled",
			"path", target,
			"added", result.Added,
			"updated", result.Updated,
			"removed", result.Removed,
			"revision", result.Revision,
		)
	}
	if scanErr != nil {
		return false, scanErr
	}
	s.setWatcherError(nil)
	return false, nil
}

func rootForWatchPath(roots []mediapath.Root, path string) (mediapath.Root, bool) {
	var selected mediapath.Root
	for _, root := range roots {
		if !pathWithinRoot(root.Path, path) || len(root.Path) <= len(selected.Path) {
			continue
		}
		selected = root
	}
	return selected, selected.Path != ""
}

func pathWithinRoot(rootPath, path string) bool {
	relative, err := filepath.Rel(rootPath, path)
	if err != nil {
		return false
	}
	return relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func mediaInsideWatchTree(item Media, rootPath, treePath string) bool {
	if treePath == rootPath {
		return true
	}
	relativeTree, err := filepath.Rel(rootPath, treePath)
	if err != nil {
		return false
	}
	itemPath := filepath.FromSlash(item.RelativePath)
	return itemPath == relativeTree ||
		strings.HasPrefix(itemPath, relativeTree+string(filepath.Separator))
}
