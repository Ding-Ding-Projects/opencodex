// Package server owns the proxy HTTP server.
//
// Its public data-plane and management routes mirror the TypeScript runtime.
// The sole Go-specific HTTP extension is GET /health/startup, consumed by the
// native tray/service supervisor before the management API is available. The
// Responses WebSocket transport upgrades the canonical /v1/responses route;
// no alternate WebSocket alias is exposed.
package server
