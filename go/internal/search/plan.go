package search

import (
	"math"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DefaultOpenAISidecarModel        = "gpt-5.6-luna"
	DefaultAnthropicSidecarModel     = "claude-sonnet-5"
	DefaultSidecarReasoning          = "low"
	DefaultMaxSearches               = 3
	DefaultSidecarTimeoutMS          = 60_000
	DefaultRoutedModelStallTimeoutMS = 200_000
	MaxRoutedModelStallTimeoutMS     = 2_147_483_647
	DefaultBridgeStallTimeoutSec     = 300
	stallMarginSec                   = 30
)

type PlanInput struct {
	HostedTool                map[string]any
	Passthrough               bool
	Enabled                   *bool
	Backend                   string
	Model                     string
	Reasoning                 string
	MaxSearches               int
	SidecarTimeoutMS          int
	RoutedModelStallTimeoutMS int
	ConnectTimeoutMS          int
	BridgeStallTimeoutSec     int
	ProviderNoVisionModels    []string
	ModelID                   string
	OpenAIAvailable           bool
	AnthropicAvailable        bool
}

type SidecarPlan struct {
	Backend                   string
	HostedTool                map[string]any
	Model                     string
	Reasoning                 string
	DescribeImages            bool
	MaxSearches               int
	TimeoutMS                 int
	RoutedModelStallTimeoutMS int
	StallTimeoutSec           int
}

func ResolveRoutedModelStallTimeoutMS(value int) int {
	if value < 1 || value > MaxRoutedModelStallTimeoutMS {
		return DefaultRoutedModelStallTimeoutMS
	}
	return value
}

func ResolveSidecarBackend(explicit string) string {
	if explicit == "anthropic" {
		return "anthropic"
	}
	return "openai"
}

func WebSearchStallTimeoutSec(configuredSec, connectTimeoutMS, routedModelStallTimeoutMS, sidecarTimeoutMS int) int {
	largest := maxInt(DefaultBridgeStallTimeoutSec, configuredSec)
	for _, milliseconds := range []int{connectTimeoutMS, routedModelStallTimeoutMS, sidecarTimeoutMS} {
		if milliseconds > 0 {
			largest = maxInt(largest, int(math.Ceil(float64(milliseconds)/1000)))
		}
	}
	maxValue := int(^uint(0) >> 1)
	if largest > maxValue-stallMarginSec {
		return maxValue
	}
	return largest + stallMarginSec
}

func ShouldResolveOpenAISidecar(hostedTool map[string]any, passthrough bool, enabled *bool, backend string) bool {
	return hostedTool != nil && !passthrough && (enabled == nil || *enabled) && ResolveSidecarBackend(backend) == "openai"
}

func BuildSidecarPlan(input PlanInput) (SidecarPlan, bool) {
	if input.HostedTool == nil || input.Passthrough || input.Enabled != nil && !*input.Enabled {
		return SidecarPlan{}, false
	}
	backend := ResolveSidecarBackend(input.Backend)
	if (backend == "anthropic" && !input.AnthropicAvailable) || (backend == "openai" && !input.OpenAIAvailable) {
		return SidecarPlan{}, false
	}
	model := input.Model
	if model == "" {
		if backend == "anthropic" {
			model = DefaultAnthropicSidecarModel
		} else {
			model = DefaultOpenAISidecarModel
		}
	}
	reasoning := input.Reasoning
	if reasoning == "" {
		reasoning = DefaultSidecarReasoning
	}
	maxSearches := input.MaxSearches
	if maxSearches == 0 {
		maxSearches = DefaultMaxSearches
	}
	timeout := input.SidecarTimeoutMS
	if timeout <= 0 {
		timeout = DefaultSidecarTimeoutMS
	}
	routedStall := ResolveRoutedModelStallTimeoutMS(input.RoutedModelStallTimeoutMS)
	connectTimeout := input.ConnectTimeoutMS
	if connectTimeout <= 0 {
		connectTimeout = DefaultRoutedModelStallTimeoutMS
	}
	return SidecarPlan{
		Backend: backend, HostedTool: cloneMap(input.HostedTool), Model: model, Reasoning: reasoning,
		DescribeImages: types.ModelInList(input.ProviderNoVisionModels, input.ModelID),
		MaxSearches:    maxSearches, TimeoutMS: timeout, RoutedModelStallTimeoutMS: routedStall,
		StallTimeoutSec: WebSearchStallTimeoutSec(input.BridgeStallTimeoutSec, connectTimeout, routedStall, timeout),
	}, true
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
