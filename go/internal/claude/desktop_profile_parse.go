package claude

import (
	"encoding/json"
	"fmt"
	"strings"
)

type DesktopProfileError struct {
	Path    string
	Message string
}

func (err *DesktopProfileError) Error() string {
	return err.Path + ": " + err.Message
}

func DecodeDesktopProfile(data []byte) (DesktopProfile, error) {
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile", Message: "must be valid JSON: " + err.Error()}
	}
	return ParseDesktopProfile(value)
}

func ParseDesktopProfile(value any) (DesktopProfile, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile", Message: "must be JSON-compatible"}
	}
	var raw struct {
		Version            int                        `json:"version"`
		Assignments        map[string]json.RawMessage `json:"assignments"`
		Defaults           map[string]json.RawMessage `json:"defaults"`
		AppliedFingerprint string                     `json:"appliedFingerprint,omitempty"`
		AppliedAt          string                     `json:"appliedAt,omitempty"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&raw); err != nil {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile", Message: err.Error()}
	}
	if raw.Version != 1 {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.version", Message: "must be 1"}
	}
	if raw.Assignments == nil {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.assignments", Message: "must be an object"}
	}
	if raw.Defaults == nil {
		return DesktopProfile{}, &DesktopProfileError{Path: "profile.defaults", Message: "must be an object"}
	}
	assignments, err := parseDesktopAssignments(raw.Assignments)
	if err != nil {
		return DesktopProfile{}, err
	}
	defaults, err := parseDesktopDefaults(raw.Defaults, assignments)
	if err != nil {
		return DesktopProfile{}, err
	}
	return DesktopProfile{Version: 1, Assignments: assignments, Defaults: defaults, AppliedFingerprint: raw.AppliedFingerprint, AppliedAt: raw.AppliedAt}, nil
}

func parseDesktopAssignments(raw map[string]json.RawMessage) (map[string]DesktopAssignment, error) {
	assignments := make(map[string]DesktopAssignment, len(raw))
	claimedAliases := make(map[string]string, len(raw))
	for route, encoded := range raw {
		if strings.TrimSpace(route) == "" || !strings.Contains(route, "/") {
			return nil, &DesktopProfileError{Path: "profile.assignments." + displayProfileRoute(route), Message: "route must be provider/model"}
		}
		var assignment DesktopAssignment
		decoder := json.NewDecoder(strings.NewReader(string(encoded)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&assignment); err != nil {
			return nil, &DesktopProfileError{Path: "profile.assignments." + route, Message: err.Error()}
		}
		if !isDesktopFamily(assignment.Family) {
			return nil, &DesktopProfileError{Path: "profile.assignments." + route + ".family", Message: "unknown family"}
		}
		if assignment.Alias == "" {
			return nil, &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: "must be a non-empty string"}
		}
		if isRealAnthropicDesktopRoute(route) {
			if assignment.Alias != routeModelID(route) {
				return nil, &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: "real Anthropic routes must keep their exact model id"}
			}
		} else if !validDesktopDateAlias(assignment.Alias) {
			return nil, &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: "must be a valid claude-opus-4-8-2026MMDD alias"}
		}
		if claimedBy, exists := claimedAliases[assignment.Alias]; exists {
			message := fmt.Sprintf("alias %q collides with route %q", assignment.Alias, claimedBy)
			return nil, &DesktopProfileError{Path: "profile.assignments." + route + ".alias", Message: message}
		}
		claimedAliases[assignment.Alias] = route
		assignments[route] = assignment
	}
	return assignments, nil
}

func parseDesktopDefaults(raw map[string]json.RawMessage, assignments map[string]DesktopAssignment) (map[DesktopFamily]*string, error) {
	if len(raw) != len(desktopFamilies) {
		return nil, &DesktopProfileError{Path: "profile.defaults", Message: "must contain exactly opus, fable, sonnet, and haiku"}
	}
	defaults := make(map[DesktopFamily]*string, len(desktopFamilies))
	for _, family := range desktopFamilies {
		encoded, ok := raw[string(family)]
		if !ok {
			return nil, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "is required"}
		}
		var route *string
		if err := json.Unmarshal(encoded, &route); err != nil {
			return nil, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "must be a route or null"}
		}
		members := desktopFamilyMembers(assignments, family)
		if len(members) == 0 && route != nil {
			return nil, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "must be null for an empty family"}
		}
		if len(members) > 0 && (route == nil || assignments[*route].Family != family) {
			return nil, &DesktopProfileError{Path: "profile.defaults." + string(family), Message: "must reference a member of this family"}
		}
		defaults[family] = route
	}
	for key := range raw {
		if !isDesktopFamily(DesktopFamily(key)) {
			return nil, &DesktopProfileError{Path: "profile.defaults", Message: fmt.Sprintf("unknown field %q", key)}
		}
	}
	return defaults, nil
}
