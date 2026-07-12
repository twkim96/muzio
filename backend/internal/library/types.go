package library

import "time"

// MediaType classifies a scanned file into the playable categories the
// frontend understands. Files that do not match a known extension are
// excluded from listings entirely and never reach this layer with a real
// type assigned.
type MediaType string

const (
	MediaTypeVideo MediaType = "video"
	MediaTypeAudio MediaType = "audio"
	MediaTypeImage MediaType = "image"
)

// Media is a single media record returned by listing and lookup APIs.
// Fields are JSON-serialized using the public API contract documented in
// the library handler.
type Media struct {
	ID           string     `json:"id"`
	Type         MediaType  `json:"type"`
	RootName     string     `json:"rootName"`
	RelativePath string     `json:"relativePath"`
	Name         string     `json:"name"`
	MIMEType     string     `json:"mimeType"`
	SizeBytes    int64      `json:"sizeBytes"`
	ModifiedAt   time.Time  `json:"modifiedAt"`
	Metadata     Metadata   `json:"metadata"`
	Thumbnail    Thumbnail  `json:"thumbnail"`
	Subtitles    []Subtitle `json:"subtitles"`
	Offline      bool       `json:"offline,omitempty"`
}

type Metadata struct {
	Title       string   `json:"title"`
	Artist      string   `json:"artist,omitempty"`
	Album       string   `json:"album,omitempty"`
	Season      int      `json:"season,omitempty"`
	Episode     int      `json:"episode,omitempty"`
	Year        int      `json:"year,omitempty"`
	DurationSec *float64 `json:"durationSec,omitempty"`
}

type Thumbnail struct {
	URL      string `json:"url"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	CacheKey string `json:"cacheKey"`
}

const (
	ThumbnailKindFallback = "generated-fallback"
	ThumbnailKindVideo    = "generated-frame"
	ThumbnailKindImage    = "generated-preview"

	ThumbnailStatusPending  = "pending"
	ThumbnailStatusReady    = "ready"
	ThumbnailStatusFallback = "fallback"
)

type Subtitle struct {
	RelativePath string `json:"relativePath"`
	Language     string `json:"language,omitempty"`
	Label        string `json:"label"`
}
