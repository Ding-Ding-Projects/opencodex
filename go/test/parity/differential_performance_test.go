package parity_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type runtimePerformance struct {
	requests  int
	duration  time.Duration
	latencies []time.Duration
	peakRSSKB int64
}

func TestTypeScriptAndGoPerformanceComparison(t *testing.T) {
	if os.Getenv("OCX_RUN_PERF") != "1" {
		t.Skip("set OCX_RUN_PERF=1 for local runtime performance measurement")
	}
	upstream := newDifferentialUpstream(t)
	config := differentialConfig(upstream.server.URL, []string{"success"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := []byte(`{"model":"differential/success","input":"performance probe","stream":true}`)
	for range 20 {
		performanceRequest(t, goProxy.baseURL, body)
		performanceRequest(t, tsProxy.baseURL, body)
	}
	goResult := measureRuntimePerformance(t, goProxy.baseURL, goProxy.command.Process.Pid, body, 600, 16)
	tsResult := measureRuntimePerformance(t, tsProxy.baseURL, tsProxy.command.Process.Pid, body, 600, 16)
	http.DefaultTransport.(*http.Transport).CloseIdleConnections()
	t.Logf("PERF_RESULT runtime=Go requests=%d throughput=%.1f_rps p50_ms=%.3f p99_ms=%.3f peak_rss_mib=%.1f",
		goResult.requests, float64(goResult.requests)/goResult.duration.Seconds(), percentile(goResult.latencies, 0.50).Seconds()*1000, percentile(goResult.latencies, 0.99).Seconds()*1000, float64(goResult.peakRSSKB)/1024)
	t.Logf("PERF_RESULT runtime=BunTS requests=%d throughput=%.1f_rps p50_ms=%.3f p99_ms=%.3f peak_rss_mib=%.1f",
		tsResult.requests, float64(tsResult.requests)/tsResult.duration.Seconds(), percentile(tsResult.latencies, 0.50).Seconds()*1000, percentile(tsResult.latencies, 0.99).Seconds()*1000, float64(tsResult.peakRSSKB)/1024)
}

func TestTypeScriptAndGoLongStreamingPerformance(t *testing.T) {
	if os.Getenv("OCX_RUN_STREAM_PERF") != "1" {
		t.Skip("set OCX_RUN_STREAM_PERF=1 for long-lived SSE performance measurement")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := writer.(http.Flusher)
		_, _ = io.WriteString(writer, "data: {\"id\":\"chatcmpl-long\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n")
		for range 100 {
			select {
			case <-request.Context().Done():
				return
			case <-time.After(10 * time.Millisecond):
			}
			_, _ = io.WriteString(writer, "data: {\"id\":\"chatcmpl-long\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"stream\"},\"finish_reason\":null}]}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = io.WriteString(writer, "data: {\"id\":\"chatcmpl-long\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":100,\"total_tokens\":101}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	config := differentialConfig(upstream.URL, []string{"long"})
	tsProxy := startTypeScriptProxy(t, config)
	goProxy := startProxyWithConfig(t, config)
	body := []byte(`{"model":"differential/long","input":"stream","stream":true}`)
	goResult := measureRuntimePerformance(t, goProxy.baseURL, goProxy.command.Process.Pid, body, 24, 24)
	tsResult := measureRuntimePerformance(t, tsProxy.baseURL, tsProxy.command.Process.Pid, body, 24, 24)
	t.Logf("STREAM_PERF_RESULT runtime=Go connections=24 p50_ms=%.1f p99_ms=%.1f peak_rss_mib=%.1f", percentile(goResult.latencies, .50).Seconds()*1000, percentile(goResult.latencies, .99).Seconds()*1000, float64(goResult.peakRSSKB)/1024)
	t.Logf("STREAM_PERF_RESULT runtime=BunTS connections=24 p50_ms=%.1f p99_ms=%.1f peak_rss_mib=%.1f", percentile(tsResult.latencies, .50).Seconds()*1000, percentile(tsResult.latencies, .99).Seconds()*1000, float64(tsResult.peakRSSKB)/1024)
}

func measureRuntimePerformance(t *testing.T, baseURL string, pid int, body []byte, requests, concurrency int) runtimePerformance {
	t.Helper()
	jobs := make(chan struct{})
	latencies := make(chan time.Duration, requests)
	var failures atomic.Int64
	stopRSS := make(chan struct{})
	var peakRSS atomic.Int64
	go samplePeakRSS(pid, stopRSS, &peakRSS)
	client := &http.Client{Timeout: 30 * time.Second}
	var workers sync.WaitGroup
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for range jobs {
				started := time.Now()
				request, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/responses", bytes.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				response, err := client.Do(request)
				if err != nil {
					failures.Add(1)
					continue
				}
				_, readErr := io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				if readErr != nil || response.StatusCode != http.StatusOK {
					failures.Add(1)
					continue
				}
				latencies <- time.Since(started)
			}
		}()
	}
	started := time.Now()
	for range requests {
		jobs <- struct{}{}
	}
	close(jobs)
	workers.Wait()
	duration := time.Since(started)
	client.CloseIdleConnections()
	close(stopRSS)
	close(latencies)
	if failures.Load() != 0 {
		t.Fatalf("performance run against %s had %d failures", baseURL, failures.Load())
	}
	result := runtimePerformance{requests: requests, duration: duration, peakRSSKB: peakRSS.Load(), latencies: make([]time.Duration, 0, requests)}
	for latency := range latencies {
		result.latencies = append(result.latencies, latency)
	}
	sort.Slice(result.latencies, func(left, right int) bool { return result.latencies[left] < result.latencies[right] })
	return result
}

func performanceRequest(t *testing.T, baseURL string, body []byte) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/responses", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("performance warmup status=%d read=%v", response.StatusCode, readErr)
	}
}

func samplePeakRSS(pid int, stop <-chan struct{}, peak *atomic.Int64) {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if rss := processRSSKB(pid); rss > peak.Load() {
			peak.Store(rss)
		}
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
	}
}

func processRSSKB(pid int) int64 {
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	value, _ := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	return value
}

func percentile(sorted []time.Duration, quantile float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	index := int(float64(len(sorted)-1) * quantile)
	return sorted[index]
}
