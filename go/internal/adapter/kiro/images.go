package kiro

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
)

type Image struct {
	Format string      `json:"format"`
	Source ImageSource `json:"source"`
}

type ImageSource struct {
	Bytes string `json:"bytes"`
}

func ParseDataURLImage(imageURL string) (Image, bool) {
	if !strings.HasPrefix(imageURL, "data:") {
		return Image{}, false
	}
	comma := strings.IndexByte(imageURL, ',')
	if comma < 0 || comma == len(imageURL)-1 {
		return Image{}, false
	}
	header, data := imageURL[5:comma], imageURL[comma+1:]
	mediaType := strings.Split(header, ";")[0]
	if mediaType == "" {
		mediaType = "image/jpeg"
	}
	format := mediaType
	if slash := strings.IndexByte(format, '/'); slash >= 0 {
		format = format[slash+1:]
	}
	format = strings.ToLower(format)
	if format == "jpg" {
		format = "jpeg"
	}
	if format == "" {
		format = "jpeg"
	}
	return Image{Format: format, Source: ImageSource{Bytes: data}}, true
}

func ExtractImages(content json.RawMessage) []Image {
	var value any
	if json.Unmarshal(content, &value) != nil {
		return nil
	}
	parts, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]Image, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		typeName, _ := part["type"].(string)
		if typeName != "image" && typeName != "input_image" && typeName != "image_url" {
			continue
		}
		url := firstString(part, "imageUrl", "image_url")
		if nested, ok := part["image_url"].(map[string]any); ok && url == "" {
			url = firstString(nested, "url")
		}
		if image, ok := ParseDataURLImage(url); ok {
			out = append(out, image)
		}
	}
	return out
}

type imageCarrier struct {
	Content string
	Images  []Image
}

func NormalizeImageCarriers(carriers []*imageCarrier) error {
	for _, carrier := range carriers {
		if len(carrier.Images) > MaxImagesPerMessage {
			carrier.Images = append([]Image(nil), carrier.Images[len(carrier.Images)-MaxImagesPerMessage:]...)
			carrier.Content = appendImageNote(carrier.Content, "[image omitted: exceeded the 20-image per-message cap; oldest images in this message were dropped]")
		}
	}
	type targetRef struct {
		state   *carrierImageState
		index   int
		dropped bool
	}
	states := make(map[*imageCarrier]*carrierImageState, len(carriers))
	for _, carrier := range carriers {
		states[carrier] = &carrierImageState{carrier: carrier}
	}
	refs := make([]*targetRef, 0)
	targets := make([]anthropic.NormalizeTarget, 0)
	for _, carrier := range carriers {
		for index := range carrier.Images {
			ref := &targetRef{state: states[carrier], index: index}
			refs = append(refs, ref)
			image := carrier.Images[index]
			targets = append(targets, anthropic.NormalizeTarget{
				Base64: image.Source.Bytes, MediaType: "image/" + image.Format,
				Replace: func(data, mediaType string) error {
					ref.state.mu.Lock()
					defer ref.state.mu.Unlock()
					format := strings.TrimPrefix(strings.ToLower(mediaType), "image/")
					if format == "jpg" {
						format = "jpeg"
					}
					ref.state.carrier.Images[ref.index] = Image{Format: format, Source: ImageSource{Bytes: data}}
					return nil
				},
				Drop: func(note string) error {
					ref.state.mu.Lock()
					defer ref.state.mu.Unlock()
					ref.dropped = true
					ref.state.carrier.Content = appendImageNote(ref.state.carrier.Content, note)
					return nil
				},
			})
		}
	}
	if err := anthropic.NormalizeImageTargets(targets, anthropic.NormalizeOptions{
		Budget: ImageBase64Budget, OverflowAction: anthropic.OverflowDrop,
	}); err != nil {
		return err
	}
	for _, carrier := range carriers {
		images := carrier.Images[:0]
		for _, ref := range refs {
			if ref.state.carrier != carrier || ref.dropped {
				continue
			}
			images = append(images, carrier.Images[ref.index])
		}
		carrier.Images = images
	}
	return nil
}

type carrierImageState struct {
	carrier *imageCarrier
	mu      sync.Mutex
}

func appendImageNote(content, note string) string {
	if content == "" {
		return note
	}
	return content + "\n" + note
}
