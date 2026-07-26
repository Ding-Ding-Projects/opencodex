package config

import "strings"

func FindCustomModel(models []CustomModel, target string) int {
	for index, model := range models {
		if model.ID == target || model.Provider+"/"+model.ModelID == target {
			return index
		}
	}
	return -1
}

func AddCustomModel(cfg *Config, model CustomModel) error {
	model.ID = strings.TrimSpace(model.ID)
	model.Provider = strings.TrimSpace(model.Provider)
	model.ModelID = strings.TrimSpace(model.ModelID)
	model.DisplayName = strings.TrimSpace(model.DisplayName)
	if FindCustomModel(cfg.CustomModels, model.Provider+"/"+model.ModelID) >= 0 {
		return &ConfigError{Field: "customModels", Message: "custom model " + model.Provider + "/" + model.ModelID + " already exists"}
	}
	cfg.CustomModels = append(cfg.CustomModels, model)
	return cfg.Validate()
}

func RemoveCustomModel(cfg *Config, target string) (CustomModel, bool) {
	index := FindCustomModel(cfg.CustomModels, strings.TrimSpace(target))
	if index < 0 {
		return CustomModel{}, false
	}
	removed := cfg.CustomModels[index]
	cfg.CustomModels = append(cfg.CustomModels[:index], cfg.CustomModels[index+1:]...)
	if len(cfg.CustomModels) == 0 {
		cfg.CustomModels = nil
	}
	return removed, true
}
