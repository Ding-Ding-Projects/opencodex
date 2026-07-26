package anthropic

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	MaxInputBase64Length      = 64 * 1024 * 1024
	MaxInputPixels            = 100_000_000
	ImageNormalizeConcurrency = 4
	maxDecodedImageBytes      = 48 * 1024 * 1024
	normalizeCacheByteCap     = 64 * 1024 * 1024

	undecodableImageText = "[image omitted: undecodable or corrupt image data]"
	unsafeImageText      = "[image omitted: image too large to process safely]"
	overflowImageText    = "[image omitted: total image payload exceeded the provider request budget; older images were dropped]"
)

// TierSpec describes one image fidelity position. HardCap is measured in
// base64 characters; MaxInt is the terminal measured-size position.
type TierSpec struct {
	MaxEdge   int
	Qualities []int
	HardCap   int
}

var ImageTierSpecs = []TierSpec{
	{MaxEdge: 2000, Qualities: []int{80, 60, 40, 30}, HardCap: 2 * 1024 * 1024},
	{MaxEdge: 1024, Qualities: []int{70, 50}, HardCap: 512 * 1024},
	{MaxEdge: 700, Qualities: []int{60, 40}, HardCap: 192 * 1024},
	{MaxEdge: 500, Qualities: []int{40}, HardCap: 100 * 1024},
	{MaxEdge: 400, Qualities: []int{30}, HardCap: 100 * 1024},
	{MaxEdge: 320, Qualities: []int{25}, HardCap: math.MaxInt},
}

type EncodedImage struct {
	Data      string
	MediaType string
}

type EncodeImageFunc func(input []byte, spec TierSpec, quality int) (EncodedImage, error)
type ValidateImageFunc func(input []byte) error

// NormalizeTarget is wire-neutral so Kiro and Anthropic can share the exact
// tier/cache/demotion machinery while retaining their native wire shapes.
type NormalizeTarget struct {
	Base64    string
	MediaType string
	Replace   func(data, mediaType string) error
	Drop      func(note string) error
}

type OverflowAction string

const (
	OverflowKeep OverflowAction = "none"
	OverflowDrop OverflowAction = "drop"
)

type NormalizeOptions struct {
	TierBias       int
	Budget         int
	OverflowAction OverflowAction
	ProcessLimit   int
	Concurrency    int
	Encode         EncodeImageFunc
	Validate       ValidateImageFunc
}

type NormalizeStats struct {
	EncodeCalls  int64
	CacheEntries int
	CacheBytes   int
}

type processKind uint8

const (
	processFailed processKind = iota
	processPass
	processEncoded
)

type processResult struct {
	kind      processKind
	data      string
	mediaType string
	position  int
	size      int
}

type normalizedTarget struct {
	target      NormalizeTarget
	source      string
	sourceMedia string
	position    int
	size        int
	done        bool
}

type cacheValueKind uint8

const (
	cachePass cacheValueKind = iota
	cacheMiss
	cacheEncoded
)

type normalizeCacheValue struct {
	kind      cacheValueKind
	data      string
	mediaType string
}

type normalizeCacheEntry struct {
	key   string
	value normalizeCacheValue
	size  int
}

type byteLRU struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	order   *list.List
	bytes   int
	cap     int
}

var (
	normalizeCache = newByteLRU(normalizeCacheByteCap)
	encodeCalls    atomic.Int64
)

func newByteLRU(capacity int) *byteLRU {
	return &byteLRU{entries: make(map[string]*list.Element), order: list.New(), cap: capacity}
}

func (cache *byteLRU) get(key string) (normalizeCacheValue, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	element, ok := cache.entries[key]
	if !ok {
		return normalizeCacheValue{}, false
	}
	cache.order.MoveToBack(element)
	return element.Value.(*normalizeCacheEntry).value, true
}

func (cache *byteLRU) put(key string, value normalizeCacheValue) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if existing := cache.entries[key]; existing != nil {
		entry := existing.Value.(*normalizeCacheEntry)
		cache.bytes -= entry.size
		cache.order.Remove(existing)
		delete(cache.entries, key)
	}
	size := len(value.data)
	for cache.bytes+size > cache.cap && cache.order.Len() > 0 {
		oldest := cache.order.Front()
		entry := oldest.Value.(*normalizeCacheEntry)
		cache.bytes -= entry.size
		delete(cache.entries, entry.key)
		cache.order.Remove(oldest)
	}
	entry := &normalizeCacheEntry{key: key, value: value, size: size}
	cache.entries[key] = cache.order.PushBack(entry)
	cache.bytes += size
}

func (cache *byteLRU) reset() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.entries = make(map[string]*list.Element)
	cache.order.Init()
	cache.bytes = 0
}

func (cache *byteLRU) stats() (entries, bytes int) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return len(cache.entries), cache.bytes
}

func GetNormalizeStatsForTests() NormalizeStats {
	entries, bytes := normalizeCache.stats()
	return NormalizeStats{EncodeCalls: encodeCalls.Load(), CacheEntries: entries, CacheBytes: bytes}
}

func ResetNormalizeStateForTests() {
	normalizeCache.reset()
	encodeCalls.Store(0)
}

// NormalizeAnthropicImages mutates base64 image blocks in already-built
// Anthropic messages. The downstream guard remains the terminal overflow
// backstop and handles the 100-image provider limit.
func NormalizeAnthropicImages(messages []any) error {
	refs := collectImageRefs(messages)
	if len(refs) == 0 {
		return nil
	}
	targets := make([]NormalizeTarget, 0, len(refs))
	for _, current := range refs {
		ref := current
		target := NormalizeTarget{MediaType: imageMediaType(ref)}
		if ref.hasData {
			target.Base64 = ref.base64
		}
		target.Replace = func(data, mediaType string) error {
			replaceImage(ref, data, mediaType)
			return nil
		}
		target.Drop = func(note string) error {
			ref.textify(note)
			return nil
		}
		targets = append(targets, target)
	}
	return NormalizeImageTargets(targets, NormalizeOptions{
		Budget: TotalImageBase64Budget, OverflowAction: OverflowKeep, ProcessLimit: MaxImagesPerRequest,
	})
}

// NormalizeImageTargets applies age tiers in a bounded worker pool, then
// demotes the oldest images until the measured aggregate fits the budget.
func NormalizeImageTargets(targets []NormalizeTarget, options NormalizeOptions) error {
	if len(targets) == 0 {
		return nil
	}
	options = normalizeOptions(options)
	entries := make([]*normalizedTarget, len(targets))
	jobs := make(chan int)
	workerCount := min(options.Concurrency, len(targets))
	var workers sync.WaitGroup
	var failureOnce sync.Once
	var firstFailure error
	workerCtxDone := make(chan struct{})

	worker := func() {
		defer workers.Done()
		for {
			select {
			case <-workerCtxDone:
				return
			case index, ok := <-jobs:
				if !ok {
					return
				}
				entry, err := normalizeFirstPass(targets[index], len(targets)-1-index, options)
				if err != nil {
					failureOnce.Do(func() {
						firstFailure = err
						close(workerCtxDone)
					})
					return
				}
				entries[index] = entry
			}
		}
	}
	workers.Add(workerCount)
	for range workerCount {
		go worker()
	}
sendLoop:
	for index := range targets {
		select {
		case <-workerCtxDone:
			break sendLoop
		case jobs <- index:
		}
	}
	close(jobs)
	workers.Wait()
	if firstFailure != nil {
		return firstFailure
	}

	total := normalizedTotal(entries)
	for total > options.Budget {
		entry := oldestDemotable(entries)
		if entry == nil {
			break
		}
		result := processAt(entry.source, entry.position+1, entry.sourceMedia, options)
		if result.kind == processFailed {
			if err := entry.target.Drop(undecodableImageText); err != nil {
				return err
			}
			total -= entry.size
			entries[indexOfEntry(entries, entry)] = nil
			continue
		}
		newSize := result.size
		if result.kind == processEncoded {
			if err := entry.target.Replace(result.data, result.mediaType); err != nil {
				return err
			}
		}
		total += newSize - entry.size
		entry.size = newSize
		entry.position = result.position
		entry.done = result.position >= len(ImageTierSpecs)-1
	}

	if options.OverflowAction == OverflowDrop {
		for index, entry := range entries {
			if total <= options.Budget {
				break
			}
			if entry == nil {
				continue
			}
			if err := entry.target.Drop(overflowImageText); err != nil {
				return err
			}
			total -= entry.size
			entries[index] = nil
		}
	}
	return nil
}

func normalizeOptions(options NormalizeOptions) NormalizeOptions {
	if options.Budget <= 0 {
		options.Budget = TotalImageBase64Budget
	}
	if options.ProcessLimit <= 0 {
		options.ProcessLimit = math.MaxInt
	}
	if options.Concurrency <= 0 {
		options.Concurrency = ImageNormalizeConcurrency
	}
	options.Concurrency = min(options.Concurrency, max(1, runtime.GOMAXPROCS(0)))
	if options.Encode == nil {
		options.Encode = defaultImageEncode
	}
	if options.Validate == nil {
		options.Validate = defaultImageValidate
	}
	if options.OverflowAction == "" {
		options.OverflowAction = OverflowKeep
	}
	return options
}

func normalizeFirstPass(target NormalizeTarget, newestIndex int, options NormalizeOptions) (*normalizedTarget, error) {
	if target.Base64 == "" || newestIndex >= options.ProcessLimit {
		return nil, nil
	}
	if target.Replace == nil || target.Drop == nil {
		return nil, fmt.Errorf("image normalize target requires replace and drop callbacks")
	}
	if len(target.Base64) > MaxInputBase64Length || base64.StdEncoding.DecodedLen(len(target.Base64)) > maxDecodedImageBytes {
		return nil, target.Drop(unsafeImageText)
	}
	if dims, known := SniffImageDimensions(target.Base64); known && exceedsPixelLimit(dims) {
		return nil, target.Drop(unsafeImageText)
	}
	position := initialTier(newestIndex, options.TierBias)
	media := strings.ToLower(target.MediaType)
	result := processAt(target.Base64, position, media, options)
	if result.kind == processFailed {
		return nil, target.Drop(undecodableImageText)
	}
	if result.kind == processEncoded {
		if err := target.Replace(result.data, result.mediaType); err != nil {
			return nil, err
		}
	}
	return &normalizedTarget{
		target: target, source: target.Base64, sourceMedia: media, position: result.position,
		size: result.size, done: result.position >= len(ImageTierSpecs)-1,
	}, nil
}

func processAt(source string, start int, media string, options NormalizeOptions) processResult {
	dims, hasDimensions := SniffImageDimensions(source)
	decoded, err := base64.StdEncoding.DecodeString(source)
	if err != nil {
		return processResult{kind: processFailed, position: start}
	}
	hash := sha256.Sum256([]byte(source))
	terminal := len(ImageTierSpecs) - 1
	start = min(max(0, start), terminal)
	for position := start; position <= terminal; position++ {
		spec := ImageTierSpecs[position]
		key := fmt.Sprintf("%x:%s:%d", hash, media, position)
		if cached, ok := normalizeCache.get(key); ok {
			switch cached.kind {
			case cachePass:
				return processResult{kind: processPass, position: position, size: len(source)}
			case cacheMiss:
				continue
			case cacheEncoded:
				return processResult{kind: processEncoded, data: cached.data, mediaType: cached.mediaType, position: position, size: len(cached.data)}
			}
		}
		fitsDimensions := hasDimensions && dims.Width <= spec.MaxEdge && dims.Height <= spec.MaxEdge
		if isAnthropicImageMedia(media) && fitsDimensions && len(source) <= spec.HardCap {
			if err := options.Validate(decoded); err != nil {
				return processResult{kind: processFailed, position: position}
			}
			normalizeCache.put(key, normalizeCacheValue{kind: cachePass})
			return processResult{kind: processPass, position: position, size: len(source)}
		}
		var last EncodedImage
		for _, quality := range spec.Qualities {
			encodeCalls.Add(1)
			encoded, err := options.Encode(decoded, spec, quality)
			if err != nil {
				return processResult{kind: processFailed, position: position}
			}
			last = encoded
			if len(encoded.Data) <= spec.HardCap {
				normalizeCache.put(key, normalizeCacheValue{kind: cacheEncoded, data: encoded.Data, mediaType: encoded.MediaType})
				return processResult{kind: processEncoded, data: encoded.Data, mediaType: encoded.MediaType, position: position, size: len(encoded.Data)}
			}
		}
		if position == terminal && last.Data != "" {
			normalizeCache.put(key, normalizeCacheValue{kind: cacheEncoded, data: last.Data, mediaType: last.MediaType})
			return processResult{kind: processEncoded, data: last.Data, mediaType: last.MediaType, position: position, size: len(last.Data)}
		}
		normalizeCache.put(key, normalizeCacheValue{kind: cacheMiss})
	}
	return processResult{kind: processFailed, position: terminal}
}

func defaultImageValidate(input []byte) error {
	_, _, err := image.Decode(bytes.NewReader(input))
	return err
}

func defaultImageEncode(input []byte, spec TierSpec, quality int) (EncodedImage, error) {
	source, _, err := image.Decode(bytes.NewReader(input))
	if err != nil {
		return EncodedImage{}, err
	}
	resized := resizeToFit(source, spec.MaxEdge)
	var output bytes.Buffer
	if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: quality}); err != nil {
		return EncodedImage{}, err
	}
	return EncodedImage{Data: base64.StdEncoding.EncodeToString(output.Bytes()), MediaType: "image/jpeg"}, nil
}

func exceedsPixelLimit(dims ImageDimensions) bool {
	if dims.Width <= 0 || dims.Height <= 0 {
		return true
	}
	return int64(dims.Width) > int64(MaxInputPixels)/int64(dims.Height)
}

func resizeToFit(source image.Image, maxEdge int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= maxEdge && height <= maxEdge {
		return source
	}
	scale := float64(maxEdge) / float64(max(width, height))
	targetWidth := max(1, int(math.Round(float64(width)*scale)))
	targetHeight := max(1, int(math.Round(float64(height)*scale)))
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	draw.CatmullRom.Scale(target, target.Bounds(), source, bounds, draw.Over, nil)
	return target
}

func initialTier(newestIndex, bias int) int {
	base := 2
	if newestIndex < 6 {
		base = 0
	} else if newestIndex < 20 {
		base = 1
	}
	return min(base+max(0, bias), len(ImageTierSpecs)-1)
}

func imageMediaType(ref imageRef) string {
	block, _ := (*ref.container)[ref.index].(map[string]any)
	source, _ := block["source"].(map[string]any)
	media, _ := source["media_type"].(string)
	return strings.ToLower(media)
}

func isAnthropicImageMedia(media string) bool {
	switch media {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func replaceImage(ref imageRef, data, media string) {
	(*ref.container)[ref.index] = map[string]any{
		"type":   "image",
		"source": map[string]any{"type": "base64", "media_type": media, "data": data},
	}
}

func normalizedTotal(entries []*normalizedTarget) int {
	total := 0
	for _, entry := range entries {
		if entry != nil {
			total += entry.size
		}
	}
	return total
}

func oldestDemotable(entries []*normalizedTarget) *normalizedTarget {
	for _, entry := range entries {
		if entry != nil && !entry.done {
			return entry
		}
	}
	return nil
}

func indexOfEntry(entries []*normalizedTarget, target *normalizedTarget) int {
	for index, entry := range entries {
		if entry == target {
			return index
		}
	}
	return -1
}
