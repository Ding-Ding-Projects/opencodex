package server

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Terminal guard regex predicates (TS src/server/responses/terminal-guard.ts).
// Bilingual EN/ZH patterns detect plan-only responses that should have used tools.
var (
	actionableRequestRE = regexp.MustCompile(`(?i)(?:\b(?:add|change|check|continue|create|debug|delete|deploy|edit|execute|fix|implement|inspect|keep going|modify|patch|proceed|refactor|remove|review|run|test|update|write)\b|继续|接着|往下|升级|修改|改(?:一下|下)?|修复|实现|添加|新增|删除|重构|更新|运行|执行|检查|查看|排查|调试|创建|写入|提交|推送|部署|看下|改成|修一下)`)
	planOnlyRequestRE   = regexp.MustCompile(`(?i)(?:暂时不要(?:调用|使用)工具|不要调用工具|不用执行|只回复(?:计划|方案)|(?:只|先|给|说|写|出|来)(?:我)?(?:一个|个|一下|份)?[^。！？\n]{0,8}?(?:计划|方案|草案|提案|思路)|(?:计划|方案|草案|提案|思路)(?:就(?:行|好|可以)|即可)|\b(?:just give|provide)\s+(?:me\s+)?(?:a\s+)?plan\b|\b(?:do not|don't)\s+(?:use|call)\s+tools?\b|\b(?:write|draft|outline|propose|give|provide|create|make|share|suggest|sketch)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+|your\s+)?(?:(?:brief|concise|short|detailed|high[-\s]?level|rough|quick|step[-\s]?by[-\s]?step|implementation|migration|refactor(?:ing)?|design|technical)\s+)*(?:plan|proposal|draft|outline|approach|strategy|design\s+doc)\b)`)
	planIntentRE        = regexp.MustCompile(`(?i)(?:\b(?:i(?:'|')m going to|i will|i(?:'|')ll|let me|next i)\b|我(?:先|会|将|接下来)|下一步)`)
	planOrCompletionRE  = regexp.MustCompile(`(?i)(?:\b(?:i(?:'|')m going to|i will|i(?:'|')ll|let me|next i|i(?:'|')ve (?:already )?(?:added|applied|changed|completed|fixed|implemented|modified|updated))\b|\b(?:done|completed|fixed|implemented|updated|applied)\b|我(?:先|会|将|接下来)|下一步|已(?:经)?(?:修改|修复|完成|应用|更新|实现|处理)|完成了|已经好了)`)
	waitingForUserRE    = regexp.MustCompile(`(?i)(?:[?？]\s*$|需要我|请(?:确认|选择|提供)|是否|要不要|可以吗|\b(?:do you want|should i|which file|please confirm|please provide)\b)`)
	explicitContinueRE  = regexp.MustCompile(`(?i)^(?:继续|接着|往下|go on|continue|proceed|keep going)\s*[.!。！]?$`)
)

const maxAnnouncementChars = 280

// TerminalGuardNudge is the developer message injected when the guard triggers
// a continuation (TS TERMINAL_GUARD_NUDGE).
const TerminalGuardNudge = "你刚才只描述了计划，没有执行任何工具。不要再次解释计划，现在立即调用必要工具执行用户任务。" +
	"只有工具返回后才总结；如果确实无法执行，请明确说明阻塞原因。"

// TerminalGuardDecision is the guard's verdict for a terminal turn.
type TerminalGuardDecision string

const (
	GuardPass      TerminalGuardDecision = "pass"
	GuardContinue  TerminalGuardDecision = "continue"
	GuardAmbiguous TerminalGuardDecision = "ambiguous"
)

// TerminalTurnAnalysis is the result of analyzing a terminal turn.
type TerminalTurnAnalysis struct {
	Decision     TerminalGuardDecision
	Reason       string
	AssistantText string
	UserText     string
	HasToolCall  bool
}

// messageText extracts text from a message's content (string or array of parts).
func messageText(content []byte) string {
	// Try string first
	var s string
	if err := json.Unmarshal(content, &s); err == nil {
		return s
	}
	// Try array of parts
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type == "text" && p.Text != "" {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// latestUserText finds the last user message text from the request context.
func latestUserText(req *types.NormalizedRequest) string {
	for i := len(req.Context.Messages) - 1; i >= 0; i-- {
		if req.Context.Messages[i].Role == "user" {
			return messageText(req.Context.Messages[i].Content)
		}
	}
	return ""
}

// recentTurnHasToolActivity checks whether the turn before the latest user
// message had tool calls or tool results.
func recentTurnHasToolActivity(req *types.NormalizedRequest) bool {
	latestUserIdx := -1
	for i := len(req.Context.Messages) - 1; i >= 0; i-- {
		if req.Context.Messages[i].Role == "user" {
			latestUserIdx = i
			break
		}
	}
	if latestUserIdx < 0 {
		return false
	}
	// Check the assistant message before the user for plan-intent without tools
	for i := latestUserIdx - 1; i >= 0; i-- {
		msg := req.Context.Messages[i]
		if msg.Role == "assistant" {
			text := messageText(msg.Content)
			if msg.ToolCallID == "" && planIntentRE.MatchString(text) {
				return false
			}
			break
		}
	}
	// Look for tool results or tool calls between the previous user and latest user
	for i := latestUserIdx - 1; i >= 0 && req.Context.Messages[i].Role != "user"; i-- {
		msg := req.Context.Messages[i]
		if msg.Role == "tool" || msg.Role == "toolResult" {
			return true
		}
		if msg.Role == "assistant" && msg.ToolCallID != "" {
			return true
		}
	}
	return false
}

// assistantTextFromEvents concatenates text_delta events.
func assistantTextFromEvents(events []types.AdapterEvent) string {
	var sb strings.Builder
	for _, e := range events {
		if e.Type == types.EventTextDelta {
			sb.WriteString(e.Text)
		}
	}
	return sb.String()
}

// AnalyzeTerminalTurn analyzes a completed turn to decide whether the guard
// should trigger a continuation (TS analyzeTerminalTurn).
func AnalyzeTerminalTurn(req *types.NormalizedRequest, events []types.AdapterEvent) TerminalTurnAnalysis {
	userText := latestUserText(req)
	text := assistantTextFromEvents(events)

	hasToolCall := false
	for _, e := range events {
		if e.Type == types.EventToolCall {
			hasToolCall = true
			break
		}
	}

	base := TerminalTurnAnalysis{
		AssistantText: text,
		UserText:      userText,
		HasToolCall:   hasToolCall,
	}

	if hasToolCall {
		base.Decision = GuardPass
		base.Reason = "normal"
		return base
	}
	if len(req.Context.Tools) == 0 {
		base.Decision = GuardPass
		base.Reason = "no_tools"
		return base
	}
	if !actionableRequestRE.MatchString(userText) {
		base.Decision = GuardPass
		base.Reason = "no_actionable_request"
		return base
	}
	if planOnlyRequestRE.MatchString(userText) {
		base.Decision = GuardPass
		base.Reason = "no_actionable_request"
		return base
	}
	if explicitContinueRE.MatchString(userText) && recentTurnHasToolActivity(req) {
		base.Decision = GuardPass
		base.Reason = "recent_tool_activity"
		return base
	}
	if waitingForUserRE.MatchString(text) {
		base.Decision = GuardPass
		base.Reason = "waiting_for_user"
		return base
	}
	if len(strings.TrimSpace(text)) > maxAnnouncementChars {
		base.Decision = GuardPass
		base.Reason = "substantive_answer"
		return base
	}
	if !planOrCompletionRE.MatchString(text) {
		base.Decision = GuardAmbiguous
		base.Reason = "no_execution_claim"
		return base
	}
	base.Decision = GuardContinue
	base.Reason = "suspicious_no_tool"
	return base
}

// GuardOptions configures the terminal guard stream wrapper.
type GuardOptions struct {
	// AdapterName gates the guard: only "anthropic" triggers analysis.
	AdapterName string
	// MaxAutoContinuations caps re-asks (clamped 0..2, default 1).
	MaxAutoContinuations int
	// Continuation starts a new event stream for the continuation request.
	Continuation func(ctx context.Context, req *types.NormalizedRequest) (<-chan types.AdapterEvent, error)
}

// GuardTerminalEventStream wraps an event channel with the terminal guard.
// On a suspicious no-tool terminal, it yields an assistant_boundary event,
// builds a continuation request, and switches to the continuation source.
func GuardTerminalEventStream(ctx context.Context, req *types.NormalizedRequest, source <-chan types.AdapterEvent, opts GuardOptions) <-chan types.AdapterEvent {
	maxCont := opts.MaxAutoContinuations
	if maxCont < 0 {
		maxCont = 0
	}
	if maxCont > 2 {
		maxCont = 2
	}
	if maxCont == 0 && opts.MaxAutoContinuations == 0 {
		maxCont = 1 // default
	}

	out := make(chan types.AdapterEvent, 16)
	go func() {
		defer close(out)
		current := source
		currentReq := req
		continuations := 0
		var seen []types.AdapterEvent

		for {
			terminalSeen := false
			for event := range current {
				if event.Type == types.EventDone {
					terminalSeen = true
					// Only guard anthropic adapter
					var analysis TerminalTurnAnalysis
					if opts.AdapterName == "anthropic" {
						analysis = AnalyzeTerminalTurn(currentReq, seen)
					} else {
						analysis = TerminalTurnAnalysis{Decision: GuardPass}
					}
					normalStop := event.StopReason != "max_tokens" && event.StopReason != "content_filter"
					if normalStop && analysis.Decision == GuardContinue && continuations < maxCont && opts.Continuation != nil {
						continuations++
						// Yield boundary
						out <- types.AdapterEvent{Type: types.EventAssistantBoundary}
						// Build continuation request
						currentReq = buildContinuationRequest(currentReq, seen)
						var err error
						current, err = opts.Continuation(ctx, currentReq)
						if err != nil {
							out <- types.AdapterEvent{Type: types.EventError, Error: err.Error()}
							return
						}
						seen = nil
						break
					}
					out <- event
					return
				}
				if event.Type == types.EventIncomplete || event.Type == types.EventError {
					terminalSeen = true
					out <- event
					return
				}
				seen = append(seen, event)
				out <- event
			}
			if !terminalSeen {
				return
			}
		}
	}()
	return out
}

// buildContinuationRequest appends the assistant's first-pass text and the
// nudge as a developer message (TS buildContinuationRequest).
func buildContinuationRequest(req *types.NormalizedRequest, events []types.AdapterEvent) *types.NormalizedRequest {
	text := assistantTextFromEvents(events)
	messages := make([]types.Message, len(req.Context.Messages), len(req.Context.Messages)+2)
	copy(messages, req.Context.Messages)

	if text != "" {
		content, _ := json.Marshal(text)
		messages = append(messages, types.Message{
			Role:    "assistant",
			Content: content,
		})
	}
	nudge, _ := json.Marshal(TerminalGuardNudge)
	messages = append(messages, types.Message{
		Role:    "developer",
		Content: nudge,
	})

	result := *req
	result.Context.Messages = messages
	return &result
}
