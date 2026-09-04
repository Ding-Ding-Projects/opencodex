package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// Key ORDER is part of the config output contract.
//
// `config show`, `config show --source` and `config export` print
// JSON.stringify of a zod-parsed object, and JavaScript objects preserve key
// INSERTION order. Go maps have none and encoding/json sorts them, so a
// decoded map re-serializes alphabetically -- every one of those three
// commands differed from the oracle on every line.
//
// The order zod produces is not the file's order either. `.passthrough()`
// builds its result by walking the SCHEMA's declared shape first, assigning
// each known key in declaration order, then appending the unknown keys in the
// order the file listed them. Measured against the oracle with a config whose
// keys were written in reverse:
//
//	file:   websockets, codexAutoStart, streamMode, providers, ... , port
//	output: port, providers, defaultProvider, openaiProviderTierVersion, ...
//	        then streamMode, websockets, codexAutoStart
//
// So the ordering is: declared keys in schema order (only those PRESENT),
// then the rest in file order.

// configSchemaKeyOrder is the declaration order of `configSchema` in
// src/config.ts. Reordering this list changes user-visible output.
var configSchemaKeyOrder = []string{
	"port",
	"providers",
	"defaultProvider",
	"openaiProviderTierVersion",
	"providerContextCaps",
	"contextCapValue",
	"multiAgentGuidanceEnabled",
	"injectionModel",
	"injectionEffort",
	"syncCodexSubagentDefaults",
	"codexShimAutoRestore",
	"grokExcludedModels",
	"streamMode",
}

// providerSchemaKeyOrder is the declaration order of `providerConfigSchema`.
var providerSchemaKeyOrder = []string{
	"adapter",
	"baseUrl",
	"apiKeyTransport",
	"responsesPath",
	"allowPrivateNetwork",
	"codexAccountMode",
	"responsesItemIdRepair",
}

// orderedConfigDocument is a config that remembers the order its keys must be
// printed in, so the ordinary printData path can render it unchanged.
type orderedConfigDocument struct {
	keys   []string
	values map[string]any
}

func (d orderedConfigDocument) MarshalJSON() ([]byte, error) {
	out := []byte{'{'}
	for index, key := range d.keys {
		if index > 0 {
			out = append(out, ',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		encodedValue, err := json.Marshal(jsSafe(d.values[key]))
		if err != nil {
			return nil, err
		}
		out = append(out, encodedKey...)
		out = append(out, ':')
		out = append(out, encodedValue...)
	}
	return append(out, '}'), nil
}

// orderConfigDocument arranges a config for printing: declared keys first in
// schema order, then everything else in `fileOrder`.
//
// `fileOrder` is the order the keys appeared in the config file. It is passed
// in rather than read from the document because a Go map cannot carry it.
func orderConfigDocument(document map[string]any, fileOrder []string) orderedConfigDocument {
	return orderRecord(document, fileOrder, configSchemaKeyOrder, providerSchemaKeyOrder)
}

// orderDefaultConfigDocument arranges the built-in defaults, which are NOT
// schema-ordered.
//
// `getDefaultConfig()` returns an object literal and readConfigDiagnostics
// hands it back untouched on the default/fallback paths -- it never goes
// through zod, so nothing reorders it. Applying the schema order here moved
// openaiProviderTierVersion above providers and split codexShimAutoRestore
// away from codexAutoStart, neither of which the oracle does.
func orderDefaultConfigDocument(document map[string]any, literalOrder []string) orderedConfigDocument {
	return orderRecord(document, literalOrder, nil, providerLiteralOrderOnly)
}

// providerLiteralOrderOnly keeps the nested provider records on the same
// literal-order path: an empty schema list, so only the recorded order
// applies, while still being non-nil so the providers branch runs.
var providerLiteralOrderOnly = []string{}

func orderRecord(record map[string]any, fileOrder []string, schemaOrder []string, providerOrder []string) orderedConfigDocument {
	ordered := orderedConfigDocument{values: make(map[string]any, len(record))}
	emitted := make(map[string]bool, len(record))
	appendKey := func(key string) {
		if emitted[key] {
			return
		}
		value, present := record[key]
		if !present {
			return
		}
		emitted[key] = true
		ordered.keys = append(ordered.keys, key)
		ordered.values[key] = value
	}
	for _, key := range schemaOrder {
		appendKey(key)
	}
	for _, key := range fileOrder {
		appendKey(key)
	}
	// A key present in the document but named by neither list still has to be
	// printed: `set` writes into the decoded map, and a value the merge added
	// never appeared in the file. Sorted, so the output stays deterministic.
	for _, key := range sortedKeys(record) {
		appendKey(key)
	}
	// Providers carry their own declaration order, one level down.
	if providers, isObject := ordered.values["providers"].(map[string]any); isObject && providerOrder != nil {
		orderedProviders := orderedConfigDocument{values: make(map[string]any, len(providers))}
		for _, name := range providerNameOrder(providers, fileOrder) {
			provider, isProviderObject := providers[name].(map[string]any)
			if !isProviderObject {
				orderedProviders.keys = append(orderedProviders.keys, name)
				orderedProviders.values[name] = providers[name]
				continue
			}
			orderedProviders.keys = append(orderedProviders.keys, name)
			orderedProviders.values[name] = orderRecord(
				provider, providerFileOrder(fileOrder, name), providerOrder, nil)
		}
		ordered.values["providers"] = orderedProviders
	}
	return ordered
}

// configKeyOrder records the key order of a config file, including the keys of
// each provider, so the printer can reproduce it.
type configKeyOrder struct {
	root      []string
	providers []string
	perName   map[string][]string
}

// providerNameOrder returns provider names in file order, then any that the
// file did not list.
func providerNameOrder(providers map[string]any, fileOrder []string) []string {
	order := decodeProviderOrder(fileOrder)
	names := make([]string, 0, len(providers))
	seen := make(map[string]bool, len(providers))
	for _, name := range order.providers {
		if _, present := providers[name]; present && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	for _, name := range sortedKeys(providers) {
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return names
}

// The provider orders travel alongside the root order in the same slice, with
// a sentinel separating them, because the printer takes one []string. The
// sentinel cannot collide with a real key: it is not a valid provider name.
const providerOrderMarker = "\x00provider\x00"

func encodeConfigKeyOrder(order configKeyOrder) []string {
	encoded := append([]string{}, order.root...)
	for _, name := range order.providers {
		encoded = append(encoded, providerOrderMarker, name)
		encoded = append(encoded, order.perName[name]...)
	}
	return encoded
}

func decodeProviderOrder(encoded []string) configKeyOrder {
	order := configKeyOrder{perName: map[string][]string{}}
	current := ""
	expectName := false
	for _, key := range encoded {
		switch {
		case key == providerOrderMarker:
			expectName = true
		case expectName:
			current = key
			expectName = false
			order.providers = append(order.providers, current)
		case current == "":
			order.root = append(order.root, key)
		default:
			order.perName[current] = append(order.perName[current], key)
		}
	}
	return order
}

func providerFileOrder(encoded []string, name string) []string {
	return decodeProviderOrder(encoded).perName[name]
}

// readConfigKeyOrder records the key order of a raw config file.
func readConfigKeyOrder(raw []byte) []string {
	order := configKeyOrder{perName: map[string][]string{}}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	root, err := readObjectKeys(decoder)
	if err != nil {
		return nil
	}
	order.root = root.keys
	if providers, present := root.children["providers"]; present {
		order.providers = providers.keys
		for _, name := range providers.keys {
			if child, ok := providers.children[name]; ok {
				order.perName[name] = child.keys
			}
		}
	}
	return encodeConfigKeyOrder(order)
}

type objectKeys struct {
	keys     []string
	children map[string]objectKeys
}

// readObjectKeys walks a JSON object two levels deep, recording key order.
// Deeper values are skipped: only the root and the provider records have a
// declared schema order to interleave with.
func readObjectKeys(decoder *json.Decoder) (objectKeys, error) {
	out := objectKeys{children: map[string]objectKeys{}}
	token, err := decoder.Token()
	if err != nil {
		return out, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim || delim != '{' {
		return out, fmt.Errorf("expected a JSON object")
	}
	for decoder.More() {
		keyToken, keyErr := decoder.Token()
		if keyErr != nil {
			return out, keyErr
		}
		key, isString := keyToken.(string)
		if !isString {
			return out, fmt.Errorf("object key was not a string")
		}
		// A duplicate key keeps its FIRST position while taking the last
		// value, which is what JSON.parse does.
		if indexOfKey(out.keys, key) < 0 {
			out.keys = append(out.keys, key)
		}
		child, childErr := readValueKeys(decoder)
		if childErr != nil {
			return out, childErr
		}
		if child != nil {
			out.children[key] = *child
		}
	}
	if _, err := decoder.Token(); err != nil {
		return out, err
	}
	return out, nil
}

func readValueKeys(decoder *json.Decoder) (*objectKeys, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil, nil
	}
	if delim == '{' {
		out := objectKeys{children: map[string]objectKeys{}}
		for decoder.More() {
			keyToken, keyErr := decoder.Token()
			if keyErr != nil {
				return nil, keyErr
			}
			key, isString := keyToken.(string)
			if !isString {
				return nil, fmt.Errorf("object key was not a string")
			}
			if indexOfKey(out.keys, key) < 0 {
				out.keys = append(out.keys, key)
			}
			child, childErr := readValueKeys(decoder)
			if childErr != nil {
				return nil, childErr
			}
			if child != nil {
				out.children[key] = *child
			}
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return &out, nil
	}
	// An array: consume it without recording order.
	for decoder.More() {
		if _, err := readValueKeys(decoder); err != nil {
			return nil, err
		}
	}
	if _, err := decoder.Token(); err != nil && err != io.EOF {
		return nil, err
	}
	return nil, nil
}
