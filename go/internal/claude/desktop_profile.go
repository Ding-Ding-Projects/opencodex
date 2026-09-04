package claude

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

type DesktopFamily string

const (
	DesktopFamilyOpus   DesktopFamily = "opus"
	DesktopFamilyFable  DesktopFamily = "fable"
	DesktopFamilySonnet DesktopFamily = "sonnet"
	DesktopFamilyHaiku  DesktopFamily = "haiku"

	desktopAliasDayCount = 365
)

var desktopFamilies = [...]DesktopFamily{
	DesktopFamilyOpus,
	DesktopFamilyFable,
	DesktopFamilySonnet,
	DesktopFamilyHaiku,
}

var desktopDateAliasPattern = regexp.MustCompile(`^claude-opus-4-8-(2026\d{4})$`)
var claudeShapedIDPattern = regexp.MustCompile(`^claude-[a-z0-9][a-z0-9.-]*$`)

type DesktopAssignment struct {
	Family DesktopFamily `json:"family"`
	Alias  string        `json:"alias"`
}

type DesktopProfile struct {
	Version            int                          `json:"version"`
	Assignments        map[string]DesktopAssignment `json:"assignments"`
	Defaults           map[DesktopFamily]*string    `json:"defaults"`
	AppliedFingerprint string                       `json:"appliedFingerprint,omitempty"`
	AppliedAt          string                       `json:"appliedAt,omitempty"`
}

type DesktopProfileModel struct {
	Route         string `json:"route"`
	Label         string `json:"label"`
	ContextWindow int    `json:"contextWindow,omitempty"`
}

type RenderedDesktopModel struct {
	DesktopProfileModel
	Name            string        `json:"name"`
	Family          DesktopFamily `json:"family"`
	IsFamilyDefault bool          `json:"isFamilyDefault"`
	Supports1M      bool          `json:"supports1m"`
}

func DesktopFamilyValues() []DesktopFamily {
	return append([]DesktopFamily(nil), desktopFamilies[:]...)
}

func EmptyDesktopProfile() DesktopProfile {
	return DesktopProfile{
		Version:     1,
		Assignments: map[string]DesktopAssignment{},
		Defaults: map[DesktopFamily]*string{
			DesktopFamilyOpus: nil, DesktopFamilyFable: nil,
			DesktopFamilySonnet: nil, DesktopFamilyHaiku: nil,
		},
	}
}

func (profile DesktopProfile) Clone() DesktopProfile {
	clone := profile
	clone.Assignments = make(map[string]DesktopAssignment, len(profile.Assignments))
	for route, assignment := range profile.Assignments {
		clone.Assignments[route] = assignment
	}
	clone.Defaults = make(map[DesktopFamily]*string, len(profile.Defaults))
	for family, route := range profile.Defaults {
		if route != nil {
			clone.Defaults[family] = stringPointer(*route)
		} else {
			clone.Defaults[family] = nil
		}
	}
	return clone
}

func ReconcileDesktopProfile(stored any, models []DesktopProfileModel) (DesktopProfile, error) {
	profile := EmptyDesktopProfile()
	var err error
	if stored != nil {
		profile, err = ParseDesktopProfile(stored)
		if err != nil {
			return DesktopProfile{}, err
		}
	}
	profile = profile.Clone()
	claimed := make(map[string]string, len(profile.Assignments))
	for route, assignment := range profile.Assignments {
		claimed[assignment.Alias] = route
	}
	sortedModels := append([]DesktopProfileModel(nil), models...)
	sort.Slice(sortedModels, func(i, j int) bool { return sortedModels[i].Route < sortedModels[j].Route })
	for _, model := range sortedModels {
		if _, exists := profile.Assignments[model.Route]; exists {
			continue
		}
		alias, err := allocateDesktopAlias(model.Route, claimed)
		if err != nil {
			return DesktopProfile{}, err
		}
		claimed[alias] = model.Route
		profile.Assignments[model.Route] = DesktopAssignment{Family: DesktopFamilyOpus, Alias: alias}
	}
	for _, family := range desktopFamilies {
		members := desktopFamilyMembers(profile.Assignments, family)
		current := profile.Defaults[family]
		if current == nil || profile.Assignments[*current].Family != family {
			if len(members) == 0 {
				profile.Defaults[family] = nil
			} else {
				profile.Defaults[family] = stringPointer(members[0])
			}
		}
	}
	return ParseDesktopProfile(profile)
}

func MoveDesktopRoute(profile DesktopProfile, route string, family DesktopFamily, makeDefault bool) (DesktopProfile, error) {
	parsed, err := ParseDesktopProfile(profile)
	if err != nil {
		return DesktopProfile{}, err
	}
	if !isDesktopFamily(family) {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.assignments." + route + ".family", Message: "unknown family"}
	}
	current, ok := parsed.Assignments[route]
	if !ok {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.assignments." + route, Message: "route is not assigned"}
	}
	if current.Family == family {
		if makeDefault {
			return SetDesktopFamilyDefault(parsed, family, stringPointer(route))
		}
		return parsed, nil
	}
	parsed.Assignments[route] = DesktopAssignment{Family: family, Alias: current.Alias}
	if defaultRoute := parsed.Defaults[current.Family]; defaultRoute != nil && *defaultRoute == route {
		members := desktopFamilyMembers(parsed.Assignments, current.Family)
		parsed.Defaults[current.Family] = firstRoutePointer(members)
	}
	if makeDefault || parsed.Defaults[family] == nil || parsed.Assignments[*parsed.Defaults[family]].Family != family {
		parsed.Defaults[family] = stringPointer(route)
	}
	return ParseDesktopProfile(parsed)
}

func SetDesktopFamilyDefault(profile DesktopProfile, family DesktopFamily, route *string) (DesktopProfile, error) {
	parsed, err := ParseDesktopProfile(profile)
	if err != nil {
		return DesktopProfile{}, err
	}
	members := desktopFamilyMembers(parsed.Assignments, family)
	if route == nil && len(members) > 0 {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "cannot clear a non-empty family default"}
	}
	if route != nil && parsed.Assignments[*route].Family != family {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "route is not a member of this family"}
	}
	parsed.Defaults[family] = route
	return ParseDesktopProfile(parsed)
}

func RenderDesktopProfile(profile DesktopProfile, models []DesktopProfileModel) ([]RenderedDesktopModel, error) {
	parsed, err := ParseDesktopProfile(profile)
	if err != nil {
		return nil, err
	}
	modelByRoute := make(map[string]DesktopProfileModel, len(models))
	for _, model := range models {
		modelByRoute[model.Route] = model
	}
	active := make(map[DesktopFamily][]string, len(desktopFamilies))
	for route, assignment := range parsed.Assignments {
		if _, ok := modelByRoute[route]; ok {
			active[assignment.Family] = append(active[assignment.Family], route)
		}
	}
	effectiveDefaults := make(map[DesktopFamily]string, len(desktopFamilies))
	ordered := make([]string, 0, len(modelByRoute))
	defaultSet := make(map[string]bool, len(desktopFamilies))
	for _, family := range desktopFamilies {
		sort.Strings(active[family])
		stored := parsed.Defaults[family]
		if stored != nil && containsRoute(active[family], *stored) {
			effectiveDefaults[family] = *stored
		} else if len(active[family]) > 0 {
			effectiveDefaults[family] = active[family][0]
		}
		if route := effectiveDefaults[family]; route != "" {
			ordered = append(ordered, route)
			defaultSet[route] = true
		}
	}
	rest := make([]string, 0, len(modelByRoute))
	for route := range parsed.Assignments {
		if _, active := modelByRoute[route]; active && !defaultSet[route] {
			rest = append(rest, route)
		}
	}
	sort.Strings(rest)
	ordered = append(ordered, rest...)
	rendered := make([]RenderedDesktopModel, 0, len(ordered))
	for _, route := range ordered {
		model := modelByRoute[route]
		assignment := parsed.Assignments[route]
		rendered = append(rendered, RenderedDesktopModel{DesktopProfileModel: model, Name: assignment.Alias, Family: assignment.Family, IsFamilyDefault: effectiveDefaults[assignment.Family] == route, Supports1M: model.ContextWindow >= OneMillion})
	}
	return rendered, nil
}

func IsClaudeShapedID(id string) bool {
	return claudeShapedIDPattern.MatchString(id)
}

func allocateDesktopAlias(route string, claimed map[string]string) (string, error) {
	if isRealAnthropicDesktopRoute(route) {
		alias := routeModelID(route)
		if existing, collision := claimed[alias]; collision && existing != route {
			return "", &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: fmt.Sprintf("Claude-shaped alias %q collides with route %q", alias, existing)}
		}
		return alias, nil
	}
	digest := sha256.Sum256([]byte(route))
	start := int(binary.BigEndian.Uint32(digest[:4]) % desktopAliasDayCount)
	for offset := 0; offset < desktopAliasDayCount; offset++ {
		alias := desktopDayAlias((start + offset) % desktopAliasDayCount)
		if _, used := claimed[alias]; !used {
			return alias, nil
		}
	}
	return "", &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: "all 365 encoded date slots are occupied"}
}

func validDesktopDateAlias(alias string) bool {
	match := desktopDateAliasPattern.FindStringSubmatch(alias)
	if len(match) != 2 {
		return false
	}
	parsed, err := time.Parse("20060102", match[1])
	return err == nil && parsed.Year() == 2026
}

func desktopDayAlias(dayIndex int) string {
	date := time.Date(2026, time.January, dayIndex+1, 0, 0, 0, 0, time.UTC)
	return "claude-opus-4-8-" + date.Format("20060102")
}

func desktopFamilyMembers(assignments map[string]DesktopAssignment, family DesktopFamily) []string {
	members := make([]string, 0)
	for route, assignment := range assignments {
		if assignment.Family == family {
			members = append(members, route)
		}
	}
	sort.Strings(members)
	return members
}

func isDesktopFamily(family DesktopFamily) bool {
	for _, candidate := range desktopFamilies {
		if family == candidate {
			return true
		}
	}
	return false
}

func isRealAnthropicDesktopRoute(route string) bool {
	return strings.HasPrefix(route, "anthropic/claude-")
}

func routeModelID(route string) string {
	if slash := strings.IndexByte(route, '/'); slash >= 0 {
		return route[slash+1:]
	}
	return route
}

func containsRoute(routes []string, route string) bool {
	index := sort.SearchStrings(routes, route)
	return index < len(routes) && routes[index] == route
}

func firstRoutePointer(routes []string) *string {
	if len(routes) == 0 {
		return nil
	}
	return stringPointer(routes[0])
}

func stringPointer(value string) *string {
	return &value
}

func displayProfileRoute(route string) string {
	if route == "" {
		return "<empty>"
	}
	return route
}
