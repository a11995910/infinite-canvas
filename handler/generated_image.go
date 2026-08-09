package handler

import (
	"errors"
	"net/http"
	"os"
	"strconv"

	"github.com/basketikun/infinite-canvas/service"
)

func TransientImage(w http.ResponseWriter, r *http.Request, id string) {
	data, contentType, err := service.ReadTransientImage(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "图片不可用", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}
