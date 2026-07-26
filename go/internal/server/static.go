package server

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
)

//go:embed static/*
var staticAssets embed.FS

var guiMIME = map[string]string{
	".html": "text/html", ".js": "application/javascript", ".css": "text/css",
	".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
	".ico": "image/x-icon",
}

// StaticHandler serves the production GUI bundle embedded from gui/dist. It
// mirrors gui-static.ts: exact files are served with its MIME table, extension-
// less client routes fall back to index.html, and missing assets return 404.
func StaticHandler() http.Handler {
	sub, _ := fs.Sub(staticAssets, "static")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		clean, ok := resolveGUIPath(r.URL)
		if !ok {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(sub, clean)
		if err != nil {
			if path.Ext(strings.TrimPrefix(r.URL.Path, "/")) != "" {
				http.NotFound(w, r)
				return
			}
			clean = "index.html"
			data, err = fs.ReadFile(sub, clean)
			if err != nil {
				http.NotFound(w, r)
				return
			}
		}
		contentType := guiMIME[path.Ext(clean)]
		if contentType == "" {
			contentType = mime.TypeByExtension(path.Ext(clean))
			if contentType == "" {
				contentType = "application/octet-stream"
			}
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", intString(len(data)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
	})
}

func resolveGUIPath(value *url.URL) (string, bool) {
	raw := value.EscapedPath()
	decoded, err := url.PathUnescape(raw)
	if err != nil || strings.ContainsRune(decoded, 0) {
		return "", false
	}
	relative := strings.TrimLeft(strings.ReplaceAll(decoded, `\`, "/"), "/")
	if relative == "" {
		relative = "index.html"
	}
	clean := path.Clean(relative)
	if clean == "." {
		clean = "index.html"
	}
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

func intString(value int) string {
	// Avoid fmt on the static hot path.
	if value == 0 {
		return "0"
	}
	var buffer [20]byte
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[position:])
}
