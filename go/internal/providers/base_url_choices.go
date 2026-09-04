package providers

import "strings"

const (
	QwenCloudTokenPlanBaseURL   = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
	QwenCloudPayGBaseURL        = "https://dashscope.aliyuncs.com/compatible-mode/v1"
	AlibabaIntlTokenPlanBaseURL = QwenCloudTokenPlanBaseURL
	AlibabaIntlPayGBaseURL      = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
)

var QwenCloudBaseURLChoices = []BaseURLChoice{{ID: "token-plan", Label: "Token plan", BaseURL: QwenCloudTokenPlanBaseURL}, {ID: "payg", Label: "Pay as you go", BaseURL: QwenCloudPayGBaseURL}, {ID: "custom", Label: "Custom"}}
var AlibabaIntlBaseURLChoices = []BaseURLChoice{{ID: "token-plan", Label: "Token plan", BaseURL: AlibabaIntlTokenPlanBaseURL}, {ID: "payg", Label: "Pay as you go", BaseURL: AlibabaIntlPayGBaseURL}, {ID: "custom", Label: "Custom"}}

func MatchBaseURLChoice(choices []BaseURLChoice, baseURL string) string {
	if len(choices) == 0 {
		return "custom"
	}
	normalized := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	custom := false
	for _, choice := range choices {
		if choice.ID == "custom" {
			custom = true
		}
		if choice.BaseURL != "" && strings.TrimRight(strings.TrimSpace(choice.BaseURL), "/") == normalized {
			return choice.ID
		}
	}
	if custom {
		return "custom"
	}
	return choices[0].ID
}
