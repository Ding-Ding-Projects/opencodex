package service

import (
	"regexp"
	"strings"
)

var taskXmlCommentsAndCdataPattern = regexp.MustCompile(`(?s)<!--.*?-->|<!\[CDATA\[.*?\]\]>`)

// TaskXmlSection returns the contents of the first matching unprefixed element.
func TaskXmlSection(xml, tag string) string {
	quotedTag := regexp.QuoteMeta(tag)
	pattern := regexp.MustCompile(`(?is)<` + quotedTag + `(?:\s[^>]*)?>(.*?)</` + quotedTag + `>`)
	match := pattern.FindStringSubmatch(xml)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

// TaskXmlWithoutCommentsAndCdata drops comment and CDATA decoys before validation.
func TaskXmlWithoutCommentsAndCdata(xml string) string {
	return taskXmlCommentsAndCdataPattern.ReplaceAllString(xml, "")
}

// TaskXmlString escapes a string using the canonical entities emitted in task XML.
func TaskXmlString(value string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	).Replace(value)
}

// TaskXmlElementCount counts unprefixed opening elements, including self-closing forms.
func TaskXmlElementCount(xml, tag string) int {
	quotedTag := regexp.QuoteMeta(tag)
	pattern := regexp.MustCompile(`(?i)<` + quotedTag + `(?:\s[^>]*?)?\s*/?>`)
	return len(pattern.FindAllStringIndex(xml, -1))
}

// TaskXmlHasPrefixedTag reports whether a namespace-prefixed form of tag appears.
func TaskXmlHasPrefixedTag(xml, tag string) bool {
	quotedTag := regexp.QuoteMeta(tag)
	pattern := regexp.MustCompile(`(?i)<[A-Za-z_][A-Za-z0-9_.-]*:` + quotedTag + `(?:[\s/>])`)
	return pattern.MatchString(xml)
}

// TaskXmlOptionalValueEquals validates an element whose absence means its schema default.
func TaskXmlOptionalValueEquals(xml, tag, expected string) bool {
	if TaskXmlHasPrefixedTag(xml, tag) {
		return false
	}
	count := TaskXmlElementCount(xml, tag)
	if count == 0 {
		return true
	}
	if count > 1 {
		return false
	}

	quotedTag := regexp.QuoteMeta(tag)
	pattern := regexp.MustCompile(`(?is)<` + quotedTag + `(?:\s[^>]*?)?>\s*([^<]*?)\s*</` + quotedTag + `>`)
	match := pattern.FindStringSubmatch(xml)
	return len(match) >= 2 && strings.EqualFold(strings.TrimSpace(match[1]), expected)
}

// WindowsTaskRegistrationHealthy validates security- and lifecycle-critical task fields.
func WindowsTaskRegistrationHealthy(xml, wscript, launcher string) bool {
	scrubbed := TaskXmlWithoutCommentsAndCdata(xml)
	if TaskXmlElementCount(scrubbed, "Data") > 0 || TaskXmlHasPrefixedTag(scrubbed, "Data") {
		return false
	}

	triggers := TaskXmlSection(scrubbed, "Triggers")
	trigger := TaskXmlSection(triggers, "LogonTrigger")
	principal := TaskXmlSection(scrubbed, "Principal")
	settings := TaskXmlSection(scrubbed, "Settings")
	action := TaskXmlSection(scrubbed, "Exec")

	return TaskXmlElementCount(triggers, "LogonTrigger") > 0 &&
		TaskXmlOptionalValueEquals(trigger, "Enabled", "true") &&
		regexp.MustCompile(`(?is)<LogonType>\s*InteractiveToken\s*</LogonType>`).MatchString(principal) &&
		TaskXmlOptionalValueEquals(principal, "RunLevel", "LeastPrivilege") &&
		TaskXmlOptionalValueEquals(settings, "Enabled", "true") &&
		regexp.MustCompile(`(?is)<MultipleInstancesPolicy>\s*IgnoreNew\s*</MultipleInstancesPolicy>`).MatchString(settings) &&
		regexp.MustCompile(`(?is)<ExecutionTimeLimit>\s*PT0S\s*</ExecutionTimeLimit>`).MatchString(settings) &&
		strings.Contains(action, "<Command>"+TaskXmlString(wscript)+"</Command>") &&
		strings.Contains(action, "<Arguments>"+TaskXmlString(`/b /nologo "`+launcher+`"`)+"</Arguments>")
}

// WindowsSchedulerXmlState is the validated state read from an exported task document.
type WindowsSchedulerXmlState struct {
	Installed           bool
	Enabled             bool
	RegistrationHealthy bool
}

// ReadWindowsSchedulerXmlState reads installation, enabled, and registration health together.
func ReadWindowsSchedulerXmlState(xml, wscript, launcher string) WindowsSchedulerXmlState {
	if len(xml) == 0 {
		return WindowsSchedulerXmlState{}
	}

	scrubbed := TaskXmlWithoutCommentsAndCdata(xml)
	hasData := TaskXmlElementCount(scrubbed, "Data") > 0 || TaskXmlHasPrefixedTag(scrubbed, "Data")
	settings := ""
	if !hasData {
		settings = TaskXmlSection(scrubbed, "Settings")
	}

	return WindowsSchedulerXmlState{
		Installed:           true,
		Enabled:             !hasData && TaskXmlOptionalValueEquals(settings, "Enabled", "true"),
		RegistrationHealthy: WindowsTaskRegistrationHealthy(xml, wscript, launcher),
	}
}
