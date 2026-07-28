package cli

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// This file is the Go form of the oracle's `configSchema`
// (src/config.ts) — the zod object plus its superRefine — and NOT of
// config.Config.Validate.
//
// The distinction is the whole point. Validate is the runtime's own
// admission check and is deliberately stricter: it rejects an unsupported
// `injectionEffort`, a `multiAgentMode` outside its enum, a blank
// `subagentModels` entry, a negative `stallTimeoutSec`. The schema accepts
// every one of those, because the fields are either absent from it or
// declared `.catch(undefined)`.
//
// Reusing Validate for `config show` therefore threw away files the
// TypeScript CLI reads happily: one unsupported effort string sent the whole
// config to `source: "fallback"`, hiding every provider, account and combo
// behind defaults. Measured against the oracle:
//
//	{"injectionEffort":"turbo", ...}  TS -> source "file"     Go -> "fallback"
//	{"port":"x", ...}                 TS -> "fallback"        Go -> "fallback"
//
// So the read/validate/import path validates against THIS, and the runtime
// keeps Validate for what it admits into the proxy.

// schemaError is a schema rejection in the oracle's reporting shape:
// `schema_invalid: <path>: <message>` with `; ` between issues.
type schemaError struct {
	issues []schemaIssue
}

type schemaIssue struct {
	path    string
	message string
}

func (e *schemaError) Error() string {
	if len(e.issues) == 0 {
		return "schema_invalid"
	}
	details := make([]string, 0, len(e.issues))
	for _, issue := range e.issues {
		path := issue.path
		if path == "" {
			path = "config"
		}
		details = append(details, path+": "+issue.message)
	}
	return "schema_invalid: " + strings.Join(details, "; ")
}

type schemaChecker struct {
	issues []schemaIssue
}

func (c *schemaChecker) add(path, message string) {
	c.issues = append(c.issues, schemaIssue{path: path, message: message})
}

func (c *schemaChecker) err() error {
	if len(c.issues) == 0 {
		return nil
	}
	return &schemaError{issues: c.issues}
}

var (
	providerNamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`)
	headerNamePattern   = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
)

var reservedProviderNames = map[string]struct{}{
	"__proto__": {}, "prototype": {}, "constructor": {},
}

var sensitiveProviderHeaders = map[string]struct{}{
	"authorization": {}, "cookie": {}, "set-cookie": {}, "proxy-authorization": {},
	"x-api-key": {}, "x-goog-api-key": {}, "x-amz-security-token": {},
}

// validateConfigSchema is the oracle's configSchema.safeParse.
//
// It reports the FIRST-encountered issues in the oracle's order, because the
// message is user-visible and compared byte-for-byte.
func validateConfigSchema(document configDocument) error {
	checker := &schemaChecker{}

	// port: z.number().int().min(0).max(65535).default(10100)
	if value, present := document["port"]; present && value != nil {
		number, isNumber := value.(float64)
		switch {
		case !isNumber:
			checker.add("port", "Invalid input: expected number, received "+jsTypeName(value))
		case number != float64(int64(number)):
			checker.add("port", "Invalid input: expected int, received number")
		case number < 0:
			checker.add("port", "Too small: expected number to be >=0")
		case number > 65535:
			checker.add("port", "Too big: expected number to be <=65535")
		}
	}

	// providers: z.record(z.string(), providerConfigSchema) — required.
	providersValue, hasProviders := document["providers"]
	// An ABSENT key and a `null` one are different inputs to zod: a missing
	// required field is "received undefined", a present null is "received
	// null". Collapsing them prints a message the TypeScript CLI never does.
	providers, providersAreObject := providersValue.(map[string]any)
	if !hasProviders {
		checker.add("providers", "Invalid input: expected record, received undefined")
	} else if !providersAreObject {
		checker.add("providers", "Invalid input: expected record, received "+jsTypeName(providersValue))
	}

	// defaultProvider: z.string().min(1).default("openai")
	defaultProvider := "openai"
	// `defaultProviderChecked` records whether the value survived the type
	// check. zod reports the length failure AND then still runs superRefine
	// against the parsed "" value, so an empty string produces BOTH the
	// Too small issue and the must-exist-in-providers issue.
	defaultProviderKnown := true
	if value, present := document["defaultProvider"]; present && value != nil {
		text, isString := value.(string)
		switch {
		case !isString:
			checker.add("defaultProvider", "Invalid input: expected string, received "+jsTypeName(value))
			defaultProviderKnown = false
		case text == "":
			checker.add("defaultProvider", "Too small: expected string to have >=1 characters")
			defaultProvider = text
		default:
			defaultProvider = text
		}
	}

	// openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional()
	if value, present := document["openaiProviderTierVersion"]; present && value != nil {
		number, isNumber := value.(float64)
		if !isNumber || (number != 1 && number != 2) {
			checker.add("openaiProviderTierVersion", "Invalid input")
		}
	}

	// providerContextCaps: z.record(z.string(), z.number().int().positive()).optional()
	if value, present := document["providerContextCaps"]; present && value != nil {
		record, isObject := value.(map[string]any)
		if !isObject {
			checker.add("providerContextCaps", "Invalid input: expected record, received "+jsTypeName(value))
		} else {
			// Sorted so a config with several bad caps reports them in a
			// stable order rather than Go's randomized map order.
			for _, key := range sortedKeys(record) {
				checkPositiveInt(checker, "providerContextCaps."+key, record[key])
			}
		}
	}

	// contextCapValue: z.number().int().positive().optional()
	if value, present := document["contextCapValue"]; present && value != nil {
		checkPositiveInt(checker, "contextCapValue", value)
	}

	// Plain optional booleans: an invalid value REJECTS (no .catch here).
	for _, field := range []string{"multiAgentGuidanceEnabled", "codexShimAutoRestore"} {
		if value, present := document[field]; present && value != nil {
			if _, isBool := value.(bool); !isBool {
				checker.add(field, "Invalid input: expected boolean, received "+jsTypeName(value))
			}
		}
	}

	// grokExcludedModels: z.array(z.string()).optional()
	if value, present := document["grokExcludedModels"]; present && value != nil {
		items, isArray := value.([]any)
		if !isArray {
			checker.add("grokExcludedModels", "Invalid input: expected array, received "+jsTypeName(value))
		} else {
			for index, item := range items {
				if _, isString := item.(string); !isString {
					checker.add(fmt.Sprintf("grokExcludedModels.%d", index),
						"Invalid input: expected string, received "+jsTypeName(item))
				}
			}
		}
	}

	// claudeCode must be a plain object when present (superRefine).
	if value, present := document["claudeCode"]; present && value != nil {
		if _, isObject := value.(map[string]any); !isObject {
			checker.add("claudeCode", "claudeCode must be an object")
		}
	}

	// Per-provider rules, in the oracle's iteration order over the record.
	if providersAreObject {
		for _, name := range sortedKeys(providers) {
			validateProviderSchema(checker, name, providers[name])
		}
		if _, known := providers[defaultProvider]; !known && defaultProviderKnown {
			checker.add("defaultProvider", "defaultProvider must exist in providers")
		}
	}

	// combos must be an object when present. The per-combo rules live with
	// the combo surface; this is the shape check the schema itself performs.
	if value, present := document["combos"]; present && value != nil {
		if _, isObject := value.(map[string]any); !isObject {
			checker.add("combos", "combos must be an object")
		}
	}

	return checker.err()
}

func validateProviderSchema(checker *schemaChecker, name string, raw any) {
	if _, reserved := reservedProviderNames[strings.ToLower(name)]; reserved || !providerNamePattern.MatchString(name) || strings.TrimSpace(name) != name {
		checker.add("providers."+name,
			"provider names must use letters, numbers, dot, underscore, or hyphen and cannot be reserved JavaScript object keys")
	}
	provider, isObject := raw.(map[string]any)
	if !isObject {
		checker.add("providers."+name, "Invalid input: expected object, received "+jsTypeName(raw))
		return
	}

	// adapter and baseUrl are REQUIRED and non-empty.
	for _, field := range []string{"adapter", "baseUrl"} {
		value, present := provider[field]
		text, isString := value.(string)
		switch {
		case !present || value == nil:
			checker.add("providers."+name+"."+field, "Invalid input: expected string, received undefined")
		case !isString:
			checker.add("providers."+name+"."+field, "Invalid input: expected string, received "+jsTypeName(value))
		case text == "":
			checker.add("providers."+name+"."+field, "Too small: expected string to have >=1 characters")
		}
	}

	for field, allowed := range map[string][]string{
		"apiKeyTransport":  {"x-api-key", "bearer"},
		"codexAccountMode": {"pool", "direct"},
	} {
		if value, present := provider[field]; present && value != nil {
			text, isString := value.(string)
			if !isString || !containsString(allowed, text) {
				checker.add("providers."+name+"."+field,
					`Invalid option: expected one of "`+strings.Join(allowed, `"|"`)+`"`)
			}
		}
	}

	if value, present := provider["allowPrivateNetwork"]; present && value != nil {
		if _, isBool := value.(bool); !isBool {
			checker.add("providers."+name+".allowPrivateNetwork",
				"Invalid input: expected boolean, received "+jsTypeName(value))
		}
	}

	// virtualModels is registry-only: persisting it is rejected outright.
	if _, present := provider["virtualModels"]; present {
		checker.add("providers."+name+".virtualModels", "virtualModels is registry-only and must not be persisted")
	}

	if text, isString := provider["baseUrl"].(string); isString && text != "" {
		if message := providerBaseURLSchemaError(text); message != "" {
			checker.add("providers."+name+".baseUrl", message)
		}
	}

	if value, present := provider["responsesPath"]; present && value != nil {
		text, isString := value.(string)
		if !isString {
			checker.add("providers."+name+".responsesPath",
				"Invalid input: expected string, received "+jsTypeName(value))
		} else if text == "" {
			checker.add("providers."+name+".responsesPath", "Too small: expected string to have >=1 characters")
		}
	}

	if value, present := provider["headers"]; present && value != nil {
		if message := providerHeadersSchemaError(value); message != "" {
			checker.add("providers."+name+".headers", message)
		}
	}
}

// providerBaseURLSchemaError mirrors providerBaseUrlConfigError: the URL must
// parse, speak http(s), and carry no credentials, query, or fragment. A
// baseUrl with embedded credentials would put them in every upstream request
// and in any log that records the destination.
func providerBaseURLSchemaError(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "baseUrl must be a valid URL"
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "baseUrl must be an http(s) URL"
	}
	if parsed.User != nil {
		return "baseUrl must not include embedded credentials"
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "baseUrl must not include query strings or fragments"
	}
	return ""
}

// providerHeadersSchemaError mirrors providerHeadersConfigError. The
// sensitive-name check is the load-bearing part: a persisted `authorization`
// header would be sent to the upstream on every request while living in a
// field nothing masks.
func providerHeadersSchemaError(value any) string {
	record, isObject := value.(map[string]any)
	if !isObject {
		return "headers must be a plain object"
	}
	names := make([]string, 0, len(record))
	for name := range record {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !headerNamePattern.MatchString(name) {
			return "headers keys must be valid HTTP header names"
		}
		if _, sensitive := sensitiveProviderHeaders[strings.ToLower(name)]; sensitive {
			return "headers must not set " + strings.ToLower(name)
		}
		if _, isString := record[name].(string); !isString {
			return "headers values must be strings"
		}
	}
	return ""
}

func checkPositiveInt(checker *schemaChecker, path string, value any) {
	number, isNumber := value.(float64)
	switch {
	case !isNumber:
		checker.add(path, "Invalid input: expected number, received "+jsTypeName(value))
	case number != float64(int64(number)):
		checker.add(path, "Invalid input: expected int, received number")
	case number <= 0:
		checker.add(path, "Too small: expected number to be >0")
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// jsTypeName reports the value the way zod names it, so a rejection message
// reads the same as the TypeScript one.
func jsTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}
