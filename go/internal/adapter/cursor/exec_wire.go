package cursor

import (
	"encoding/base64"
	"fmt"
	"strconv"
)

// UnmarshalExecServerMessage decodes the native-exec subset that is safe and
// useful in a headless proxy. Unknown oneof cases are ignored so protocol
// additions cannot tear down a live Cursor stream.
func UnmarshalExecServerMessage(data []byte) (ExecRequest, error) {
	fields, err := parseFields(data)
	if err != nil {
		return ExecRequest{}, fmt.Errorf("decode Cursor exec request: %w", err)
	}
	req := ExecRequest{}
	for _, field := range fields {
		switch field.Number {
		case 1:
			req.ID = strconv.FormatUint(field.Varint, 10)
		case 15:
			req.ExecID = string(field.Bytes)
		case 10:
			req.Kind = ExecRequestContext
		case 11:
			req.Kind = ExecMCP
			tool, err := unmarshalMCPArgs(field.Bytes)
			if err != nil {
				return ExecRequest{}, err
			}
			req.Tool = &tool
		case 17:
			req.Kind = ExecListResources
			tool := ToolRequest{}
			if nested, err := parseFields(field.Bytes); err == nil {
				for _, f := range nested {
					if f.Number == 1 {
						tool.Server = string(f.Bytes)
					}
				}
			}
			req.Tool = &tool
		case 18:
			req.Kind = ExecReadResource
			tool, err := unmarshalReadResourceArgs(field.Bytes)
			if err != nil {
				return ExecRequest{}, err
			}
			req.Tool = &tool
		case 21:
			req.Kind = ExecRecordScreen
			record, err := unmarshalRecordScreenArgs(field.Bytes)
			if err != nil {
				return ExecRequest{}, err
			}
			req.RecordScreen = &record
		case 22:
			req.Kind = ExecComputerUse
			computer, err := unmarshalComputerUseArgs(field.Bytes)
			if err != nil {
				return ExecRequest{}, err
			}
			req.ComputerUse = &computer
		}
	}
	return req, nil
}

func unmarshalMCPArgs(data []byte) (ToolRequest, error) {
	fields, err := parseFields(data)
	if err != nil {
		return ToolRequest{}, fmt.Errorf("decode Cursor MCP args: %w", err)
	}
	req := ToolRequest{Arguments: make(map[string]any)}
	var name, toolName string
	for _, field := range fields {
		switch field.Number {
		case 1:
			name = string(field.Bytes)
		case 2:
			entry, err := parseFields(field.Bytes)
			if err != nil {
				return ToolRequest{}, err
			}
			var key string
			var raw []byte
			for _, ef := range entry {
				if ef.Number == 1 {
					key = string(ef.Bytes)
				} else if ef.Number == 2 {
					raw = ef.Bytes
				}
			}
			if key != "" {
				value, err := UnmarshalValue(raw)
				if err != nil {
					return ToolRequest{}, fmt.Errorf("decode Cursor MCP argument %q: %w", key, err)
				}
				req.Arguments[key] = value
			}
		case 4:
			req.ProviderIdentifier = string(field.Bytes)
		case 5:
			toolName = string(field.Bytes)
		}
	}
	req.Name = firstNonEmpty(toolName, name)
	return req, nil
}

func unmarshalReadResourceArgs(data []byte) (ToolRequest, error) {
	fields, err := parseFields(data)
	if err != nil {
		return ToolRequest{}, fmt.Errorf("decode Cursor read-resource args: %w", err)
	}
	req := ToolRequest{}
	for _, field := range fields {
		if field.Number == 1 {
			req.Server = string(field.Bytes)
		} else if field.Number == 2 {
			req.URI = string(field.Bytes)
		}
	}
	return req, nil
}

func unmarshalRecordScreenArgs(data []byte) (RecordScreenRequest, error) {
	fields, err := parseFields(data)
	if err != nil {
		return RecordScreenRequest{}, fmt.Errorf("decode Cursor record-screen args: %w", err)
	}
	req := RecordScreenRequest{}
	for _, field := range fields {
		switch field.Number {
		case 1:
			req.Mode = strconv.FormatUint(field.Varint, 10)
		case 2:
			req.ToolCallID = string(field.Bytes)
		case 3:
			req.SaveAsFilename = string(field.Bytes)
		}
	}
	return req, nil
}

func unmarshalComputerUseArgs(data []byte) (ComputerUseRequest, error) {
	fields, err := parseFields(data)
	if err != nil {
		return ComputerUseRequest{}, fmt.Errorf("decode Cursor computer-use args: %w", err)
	}
	req := ComputerUseRequest{}
	for _, field := range fields {
		if field.Number == 1 {
			req.ToolCallID = string(field.Bytes)
		} else if field.Number == 2 {
			action, err := unmarshalComputerAction(field.Bytes)
			if err != nil {
				return ComputerUseRequest{}, err
			}
			req.Actions = append(req.Actions, action)
		}
	}
	return req, nil
}

var computerActionNames = map[int]string{
	1: "mouseMove", 2: "click", 3: "mouseDown", 4: "mouseUp", 5: "drag",
	6: "scroll", 7: "type", 8: "key", 9: "wait", 10: "screenshot", 11: "cursorPosition",
}

func unmarshalComputerAction(data []byte) (map[string]any, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor computer action: %w", err)
	}
	if len(fields) == 0 {
		return map[string]any{"action": map[string]any{}}, nil
	}
	field := fields[len(fields)-1]
	name := computerActionNames[field.Number]
	if name == "" {
		name = fmt.Sprintf("unknown%d", field.Number)
	}
	value, err := unmarshalComputerActionValue(field.Number, field.Bytes)
	if err != nil {
		return nil, err
	}
	return map[string]any{"action": map[string]any{"case": name, "value": value}}, nil
}

func unmarshalComputerActionValue(kind int, data []byte) (map[string]any, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor computer action value: %w", err)
	}
	value := make(map[string]any)
	for _, field := range fields {
		switch kind {
		case 1:
			if field.Number == 1 {
				value["coordinate"], err = unmarshalCoordinate(field.Bytes)
			}
		case 2:
			switch field.Number {
			case 1:
				value["coordinate"], err = unmarshalCoordinate(field.Bytes)
			case 2:
				value["button"] = int32(field.Varint)
			case 3:
				value["count"] = int32(field.Varint)
			case 4:
				value["modifierKeys"] = string(field.Bytes)
			}
		case 3, 4:
			if field.Number == 1 {
				value["button"] = int32(field.Varint)
			}
		case 5:
			if field.Number == 1 {
				coordinate, coordinateErr := unmarshalCoordinate(field.Bytes)
				if coordinateErr != nil {
					return nil, coordinateErr
				}
				value["path"] = appendMap(value["path"], coordinate)
			} else if field.Number == 2 {
				value["button"] = int32(field.Varint)
			}
		case 6:
			switch field.Number {
			case 1:
				value["coordinate"], err = unmarshalCoordinate(field.Bytes)
			case 2:
				value["direction"] = int32(field.Varint)
			case 3:
				value["amount"] = int32(field.Varint)
			case 4:
				value["modifierKeys"] = string(field.Bytes)
			}
		case 7:
			if field.Number == 1 {
				value["text"] = string(field.Bytes)
			}
		case 8:
			if field.Number == 1 {
				value["key"] = string(field.Bytes)
			} else if field.Number == 2 {
				value["holdDurationMs"] = int32(field.Varint)
			}
		case 9:
			if field.Number == 1 {
				value["durationMs"] = int32(field.Varint)
			}
		}
		if err != nil {
			return nil, err
		}
	}
	return value, nil
}

func appendMap(current any, value map[string]any) []map[string]any {
	items, _ := current.([]map[string]any)
	return append(items, value)
}

func unmarshalCoordinate(data []byte) (map[string]any, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, err
	}
	coordinate := map[string]any{}
	for _, field := range fields {
		if field.Number == 1 {
			coordinate["x"] = int32(field.Varint)
		} else if field.Number == 2 {
			coordinate["y"] = int32(field.Varint)
		}
	}
	return coordinate, nil
}

// MarshalExecClientMessage encodes a transport-neutral native-exec response.
func MarshalExecClientMessage(response ExecResponse) ([]byte, error) {
	id, err := strconv.ParseUint(response.ID, 10, 32)
	if err != nil && response.ID != "" {
		return nil, fmt.Errorf("invalid Cursor exec id %q", response.ID)
	}
	client := appendVarintField(nil, 1, id)
	client = appendString(client, 15, response.ExecID)
	field, result, err := marshalExecResult(response)
	if err != nil {
		return nil, err
	}
	if field == 0 {
		return nil, nil
	}
	client = appendMessage(client, field, result)
	return appendMessage(nil, 2, client), nil
}

func marshalExecResult(response ExecResponse) (int, []byte, error) {
	switch response.Kind {
	case ExecRequestContext:
		definitions, _ := response.Value.([]MCPToolDefinition)
		var context []byte
		for _, definition := range definitions {
			context = appendMessage(context, 7, marshalTool(definition))
		}
		return 10, appendMessage(nil, 1, appendMessage(nil, 1, context)), nil
	case ExecMCP:
		return 11, marshalMCPResult(response), nil
	case ExecListResources:
		return 17, marshalListResourcesResult(response), nil
	case ExecReadResource:
		return 18, marshalReadResourceResult(response), nil
	case ExecRecordScreen:
		return 21, marshalRecordScreenResult(response), nil
	case ExecComputerUse:
		return 22, marshalComputerUseResult(response), nil
	default:
		return 0, nil, nil
	}
}

func marshalMCPResult(response ExecResponse) []byte {
	if response.Error != "" {
		if result, ok := response.Value.(ToolResult); ok && len(result.AvailableTools) > 0 {
			missing := appendString(nil, 1, "")
			for _, name := range result.AvailableTools {
				missing = appendString(missing, 2, name)
			}
			return appendMessage(nil, 5, missing)
		}
		return appendMessage(nil, 2, appendString(nil, 1, response.Error))
	}
	result, _ := response.Value.(ToolResult)
	var success []byte
	for _, content := range result.Content {
		var item []byte
		if content.Type == "image" && content.Data != "" {
			data, err := base64.StdEncoding.DecodeString(content.Data)
			if err == nil && len(data) > 0 {
				image := appendBytes(nil, 1, data)
				image = appendString(image, 2, firstNonEmpty(content.MIMEType, "application/octet-stream"))
				item = appendMessage(item, 2, image)
			}
		}
		if len(item) == 0 {
			text := content.Text
			if text == "" {
				text = "[" + firstNonEmpty(content.Type, "content") + "]"
			}
			item = appendMessage(item, 1, appendString(nil, 1, text))
		}
		success = appendMessage(success, 1, item)
	}
	if result.IsError {
		success = appendVarintField(success, 2, 1)
	}
	return appendMessage(nil, 1, success)
}

func marshalListResourcesResult(response ExecResponse) []byte {
	if response.Error != "" {
		return appendMessage(nil, 2, appendString(nil, 1, response.Error))
	}
	result, _ := response.Value.(ToolResult)
	var success []byte
	for _, resource := range result.Resources {
		entry := appendString(nil, 1, resource.URI)
		entry = appendString(entry, 2, resource.Name)
		entry = appendString(entry, 3, resource.Description)
		entry = appendString(entry, 4, resource.MIMEType)
		entry = appendString(entry, 5, resource.Server)
		success = appendMessage(success, 1, entry)
	}
	return appendMessage(nil, 1, success)
}

func marshalReadResourceResult(response ExecResponse) []byte {
	if response.Error != "" {
		return appendMessage(nil, 2, appendString(appendString(nil, 1, ""), 2, response.Error))
	}
	result, _ := response.Value.(ToolResult)
	if result.Resource == nil {
		return appendMessage(nil, 4, nil)
	}
	resource := result.Resource
	success := appendString(nil, 1, resource.URI)
	success = appendString(success, 4, resource.MIMEType)
	if len(resource.Blob) > 0 {
		success = appendBytes(success, 6, resource.Blob)
	} else {
		success = appendString(success, 5, resource.Text)
	}
	return appendMessage(nil, 1, success)
}

func marshalComputerUseResult(response ExecResponse) []byte {
	if response.Error != "" {
		errorResult := appendString(nil, 1, response.Error)
		if request, ok := response.Value.(ComputerUseResult); ok {
			errorResult = appendVarintField(errorResult, 2, uint64(request.ActionCount))
		}
		return appendMessage(nil, 2, errorResult)
	}
	result, _ := response.Value.(ComputerUseResult)
	success := appendVarintField(nil, 1, uint64(result.ActionCount))
	success = appendVarintField(success, 2, uint64(result.DurationMS))
	success = appendString(success, 3, result.Screenshot)
	success = appendString(success, 4, result.Log)
	success = appendString(success, 5, result.ScreenshotPath)
	return appendMessage(nil, 1, success)
}

func marshalRecordScreenResult(response ExecResponse) []byte {
	if response.Error != "" {
		return appendMessage(nil, 4, appendString(nil, 1, response.Error))
	}
	result, _ := response.Value.(RecordScreenResult)
	switch result.Kind {
	case "start":
		var start []byte
		if result.PriorRecordingCancelled {
			start = appendVarintField(start, 1, 1)
		}
		if result.SaveAsFilenameIgnored {
			start = appendVarintField(start, 2, 1)
		}
		return appendMessage(nil, 1, start)
	case "save":
		save := appendString(nil, 1, result.Path)
		save = appendVarintField(save, 2, uint64(result.RecordingDurationMS))
		return appendMessage(nil, 2, save)
	case "discard":
		return appendMessage(nil, 3, nil)
	default:
		return appendMessage(nil, 4, appendString(nil, 1, "record-screen executor returned no recognized result"))
	}
}
