package httpserver

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

func webAppHandler(root http.FileSystem) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		file, stat, ok := openStaticFile(root, name)
		if !ok {
			if strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
			file, stat, ok = openStaticFile(root, "index.html")
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		defer file.Close()

		if contentType := contentTypeForStaticFile(name); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		if compressibleStaticAsset("/" + name) {
			headerAddToken(w.Header(), "Vary", "Accept-Encoding")
		}
		if hashedStaticAsset(name) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), file)
	}
}

func openStaticFile(root http.FileSystem, name string) (http.File, fs.FileInfo, bool) {
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, false
	}
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		file.Close()
		return nil, nil, false
	}
	return file, stat, true
}

func contentTypeForStaticFile(name string) string {
	if strings.HasSuffix(name, ".webmanifest") {
		return "application/manifest+json; charset=utf-8"
	}
	return mime.TypeByExtension(path.Ext(name))
}

func hashedStaticAsset(name string) bool {
	if !strings.HasPrefix(name, "assets/") {
		return false
	}
	base := path.Base(name)
	extension := path.Ext(base)
	stem := strings.TrimSuffix(base, extension)
	const viteHashLength = 8
	if len(stem) <= viteHashLength || stem[len(stem)-viteHashLength-1] != '-' {
		return false
	}
	hash := stem[len(stem)-viteHashLength:]
	for _, character := range hash {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '_' &&
			character != '-' {
			return false
		}
	}
	return true
}
