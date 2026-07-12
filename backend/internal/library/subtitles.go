package library

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
)

var subtitleExts = map[string]struct{}{
	".srt": {},
	".vtt": {},
	".ass": {},
}

type subtitleCandidate struct {
	name         string
	relativePath string
}

type subtitleCandidateIndex struct {
	candidates  []subtitleCandidate
	links       []subtitleCandidateLink
	byMediaBase map[string]int
	built       bool
}

type subtitleCandidateLink struct {
	candidate int
	next      int
}

func (index *subtitleCandidateIndex) add(candidate subtitleCandidate) {
	index.candidates = append(index.candidates, candidate)
	index.built = false
}

func (index *subtitleCandidateIndex) addMediaPath(mediaPath string) {
	if index.byMediaBase == nil {
		index.byMediaBase = make(map[string]int, len(index.candidates))
	}
	base := strings.TrimSuffix(filepath.Base(mediaPath), filepath.Ext(mediaPath))
	if _, exists := index.byMediaBase[base]; !exists {
		index.byMediaBase[base] = 0
		index.built = false
	}
}

func (index *subtitleCandidateIndex) build() {
	_ = index.buildContext(context.Background(), nil)
}

func (index *subtitleCandidateIndex) buildContext(
	ctx context.Context,
	pause func(context.Context, bool) error,
) error {
	if index.built {
		return nil
	}
	for base := range index.byMediaBase {
		index.byMediaBase[base] = 0
	}
	index.links = make([]subtitleCandidateLink, 0, len(index.candidates))
	for candidateIndex, candidate := range index.candidates {
		if candidateIndex%128 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			if pause != nil {
				if err := pause(ctx, false); err != nil {
					return err
				}
			}
		}
		stem := strings.TrimSuffix(candidate.name, filepath.Ext(candidate.name))
		index.linkIfMediaBase(stem, candidateIndex)
		for offset := strings.IndexByte(stem, '.'); offset > 0; {
			index.linkIfMediaBase(stem[:offset], candidateIndex)
			next := strings.IndexByte(stem[offset+1:], '.')
			if next < 0 {
				break
			}
			offset += next + 1
		}
	}
	index.built = true
	return nil
}

func (index *subtitleCandidateIndex) linkIfMediaBase(base string, candidate int) {
	head, exists := index.byMediaBase[base]
	if !exists {
		return
	}
	index.links = append(index.links, subtitleCandidateLink{
		candidate: candidate,
		next:      head,
	})
	index.byMediaBase[base] = len(index.links)
}

func newSubtitleCandidateIndex(candidates []subtitleCandidate) *subtitleCandidateIndex {
	index := &subtitleCandidateIndex{
		candidates: make([]subtitleCandidate, 0, len(candidates)),
	}
	for _, candidate := range candidates {
		index.add(candidate)
	}
	return index
}

func subtitlesFromCandidates(mediaPath string, candidates []subtitleCandidate) []Subtitle {
	return subtitlesFromCandidateIndex(
		mediaPath,
		newSubtitleCandidateIndex(candidates),
	)
}

func subtitlesFromCandidateIndex(
	mediaPath string,
	index *subtitleCandidateIndex,
) []Subtitle {
	index.addMediaPath(mediaPath)
	index.build()
	subtitles, _ := subtitlesFromCandidateIndexContext(
		context.Background(),
		mediaPath,
		index,
		nil,
	)
	return subtitles
}

func subtitlesFromCandidateIndexContext(
	ctx context.Context,
	mediaPath string,
	index *subtitleCandidateIndex,
	pause func(context.Context, bool) error,
) ([]Subtitle, error) {
	if index == nil {
		return nil, nil
	}
	base := strings.TrimSuffix(filepath.Base(mediaPath), filepath.Ext(mediaPath))
	var out []Subtitle
	position := 0
	for link := index.byMediaBase[base]; link != 0; {
		if position%128 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if pause != nil {
				if err := pause(ctx, false); err != nil {
					return nil, err
				}
			}
		}
		current := index.links[link-1]
		link = current.next
		position++
		candidate := index.candidates[current.candidate]
		stem := strings.TrimSuffix(candidate.name, filepath.Ext(candidate.name))
		language := subtitleLanguage(base, stem)
		label := "Subtitle"
		if language != "" {
			label = strings.ToUpper(language)
		}
		out = append(out, Subtitle{
			RelativePath: candidate.relativePath,
			Language:     language,
			Label:        label,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].RelativePath < out[j].RelativePath
	})
	return out, nil
}

func isSubtitleFile(name string) bool {
	_, ok := subtitleExts[strings.ToLower(filepath.Ext(name))]
	return ok
}

func subtitleLanguage(mediaBase, subtitleStem string) string {
	if subtitleStem == mediaBase {
		return ""
	}
	suffix := strings.TrimPrefix(subtitleStem, mediaBase+".")
	if suffix == "" || strings.Contains(suffix, ".") {
		return ""
	}
	if len(suffix) < 2 || len(suffix) > 8 {
		return ""
	}
	return strings.ToLower(suffix)
}
