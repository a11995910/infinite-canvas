package handler

import (
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/service"
)

func TransientImage(w http.ResponseWriter, r *http.Request, id string) {
	data, contentType, err := service.ReadTransientImage(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}
