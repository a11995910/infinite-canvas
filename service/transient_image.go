package service

import (
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/google/uuid"
)

const transientImageTTL = 24 * time.Hour

// SaveTransientImage stores a short-lived image without requiring object storage.
func SaveTransientImage(data []byte, contentType string) (string, error) {
	if len(data) == 0 {
		return "", errors.New("图片内容为空")
	}
	dir := transientImageDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	id := uuid.NewString()
	ext := transientImageExtension(contentType)
	if err := os.WriteFile(filepath.Join(dir, id+ext), data, 0600); err != nil {
		return "", err
	}
	cleanupTransientImages(dir)
	return id, nil
}

func ReadTransientImage(id string) ([]byte, string, error) {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return nil, "", errors.New("图片地址无效")
	}
	matches, err := filepath.Glob(filepath.Join(transientImageDir(), id+".*"))
	if err != nil || len(matches) == 0 {
		return nil, "", os.ErrNotExist
	}
	info, err := os.Stat(matches[0])
	if err != nil {
		return nil, "", err
	}
	if time.Since(info.ModTime()) > transientImageTTL {
		_ = os.Remove(matches[0])
		return nil, "", os.ErrNotExist
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		return nil, "", err
	}
	contentType := mime.TypeByExtension(filepath.Ext(matches[0]))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	return data, contentType, nil
}

func transientImageDir() string {
	dir := strings.TrimSpace(config.Cfg.TransientImageDir)
	if dir == "" {
		return "data/generated-images"
	}
	return dir
}

func transientImageExtension(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/png":
		return ".png"
	default:
		return ".bin"
	}
}

func cleanupTransientImages(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-transientImageTTL)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
