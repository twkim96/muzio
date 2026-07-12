package library

import (
	"path/filepath"
	"strings"
)

// extInfo carries the classification and MIME type for a known media extension.
// Keeping the MIME table in this package keeps Content-Type stable across
// platforms; relying on mime.TypeByExtension would defer to OS-specific
// /etc/mime.types files and produce different strings on different machines.
type extInfo struct {
	mediaType MediaType
	mime      string
}

var extTable = map[string]extInfo{
	// Video.
	".mp4":  {MediaTypeVideo, "video/mp4"},
	".m4v":  {MediaTypeVideo, "video/mp4"},
	".mov":  {MediaTypeVideo, "video/quicktime"},
	".mkv":  {MediaTypeVideo, "video/x-matroska"},
	".webm": {MediaTypeVideo, "video/webm"},
	".avi":  {MediaTypeVideo, "video/x-msvideo"},
	".ts":   {MediaTypeVideo, "video/mp2t"},
	".mpg":  {MediaTypeVideo, "video/mpeg"},
	".mpeg": {MediaTypeVideo, "video/mpeg"},
	".wmv":  {MediaTypeVideo, "video/x-ms-wmv"},
	".flv":  {MediaTypeVideo, "video/x-flv"},

	// Audio.
	".mp3":  {MediaTypeAudio, "audio/mpeg"},
	".m4a":  {MediaTypeAudio, "audio/mp4"},
	".aac":  {MediaTypeAudio, "audio/aac"},
	".flac": {MediaTypeAudio, "audio/flac"},
	".alac": {MediaTypeAudio, "audio/mp4"},
	".wav":  {MediaTypeAudio, "audio/wav"},
	".ogg":  {MediaTypeAudio, "audio/ogg"},
	".opus": {MediaTypeAudio, "audio/ogg"},
	".wma":  {MediaTypeAudio, "audio/x-ms-wma"},

	// Image.
	".jpg":  {MediaTypeImage, "image/jpeg"},
	".jpeg": {MediaTypeImage, "image/jpeg"},
	".png":  {MediaTypeImage, "image/png"},
	".gif":  {MediaTypeImage, "image/gif"},
	".webp": {MediaTypeImage, "image/webp"},
	".avif": {MediaTypeImage, "image/avif"},
	".bmp":  {MediaTypeImage, "image/bmp"},
	".heic": {MediaTypeImage, "image/heic"},
	".heif": {MediaTypeImage, "image/heif"},
}

// classifyExt returns the media type for a file name based on its extension.
// The second return value is false for files that should be ignored by the
// scanner.
func classifyExt(name string) (MediaType, bool) {
	if info, ok := extTable[strings.ToLower(filepath.Ext(name))]; ok {
		return info.mediaType, true
	}
	return "", false
}

// MIMEFor returns the Content-Type the streaming layer should advertise for
// the given file name. The second return value is false for files that fall
// outside the classified extension table; callers should refuse to serve
// those rather than guessing a default.
func MIMEFor(name string) (string, bool) {
	if info, ok := extTable[strings.ToLower(filepath.Ext(name))]; ok {
		return info.mime, true
	}
	return "", false
}
