package service

import (
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ListPrompts(q model.Query) (model.PromptList, error) {
	items, total, err := repository.ListPrompts(q)
	if err != nil {
		return model.PromptList{}, err
	}
	tags, err := repository.ListPromptTags(q)
	if err != nil {
		return model.PromptList{}, err
	}
	categories := promptCategoryCodes(ListPromptCategories())
	sanitizePublicPrompts(items)
	return model.PromptList{Items: items, Tags: tags, Categories: categories, Total: int(total)}, nil
}

func ListPromptCategories() []model.PromptCategory {
	categories, _ := repository.ListPromptCategories()
	return categories
}

func SavePrompt(item model.Prompt) (model.Prompt, error) {
	now := time.Now().Format(time.RFC3339)
	if item.Category == "" {
		item.Category = repository.PromptCategories()[0].Category
	}
	if item.ID == "" {
		item.ID = newID(item.Category)
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	category, ok := repository.PromptCategoryByCode(item.Category)
	if !ok {
		category = repository.PromptCategories()[0]
		item.Category = category.Category
	}
	item.GithubURL = ""
	return repository.SavePrompt(item)
}

func DeletePrompt(id string) error {
	return repository.DeletePrompt(id)
}

func DeletePrompts(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return repository.DeletePrompts(ids)
}

func promptCategoryCodes(items []model.PromptCategory) []string {
	codes := []string{}
	for _, item := range items {
		if item.Category != "" {
			codes = append(codes, item.Category)
		}
	}
	return codes
}

func sanitizePublicPrompts(items []model.Prompt) {
	for i := range items {
		items[i].GithubURL = ""
		if isGitHubURL(items[i].CoverURL) {
			items[i].CoverURL = ""
		}
		if containsGitHubURL(items[i].Preview) {
			items[i].Preview = ""
		}
	}
}

func isGitHubURL(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(normalized, "https://github.com/") ||
		strings.HasPrefix(normalized, "http://github.com/") ||
		strings.HasPrefix(normalized, "https://raw.githubusercontent.com/") ||
		strings.HasPrefix(normalized, "http://raw.githubusercontent.com/")
}

func containsGitHubURL(value string) bool {
	normalized := strings.ToLower(value)
	return strings.Contains(normalized, "github.com/") ||
		strings.Contains(normalized, "raw.githubusercontent.com/")
}
