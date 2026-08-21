# Data-plane tenant boundary (contract slice)

This document records the first safe tenant boundary for centrally hosted deployments. It is
deliberately a contract slice, not a claim that the whole multi-user roadmap is complete.

## Identity and admission

An operator-owned bootstrap path may configure a bounded in-process registry through
`TenantBoundary.configure`. Each record has a stable tenant id, a dedicated admission key, and
provider/model allowlists. The key is immediately reduced to a SHA-256 digest; the raw key is never
stored in the registry, returned by an API, logged, or used as the forwarded provider credential.

The data plane reads only `X-OpenCodex-Tenant-Key` for this contract. The existing `Authorization`
header remains the provider-forwarding credential and cannot establish the OpenCodex tenant. An
empty registry preserves the existing single-user behavior. Management routes do not expose the
registry or its credentials.

## Authorization and catalog projection

When the registry is enabled, every `/v1/*` request requires the dedicated tenant key before
dispatch. JSON inference bodies are bounded and inspected from a clone before routing; the
canonical model/provider identity is checked against the tenant policy. `GET /v1/models` filters
every catalog shape (OpenAI list, Codex client catalog, and Anthropic model information) through
the same allowlist. A missing key is `401`; an invalid key or disallowed model/provider is `403`;
neither response contains a credential or request payload. The WebSocket upgrade path applies the
same admission check before the upgrade.

## History isolation

`requestHistoryKey` prefixes a bounded request identifier with the admitted tenant id. The prefix
is an attribution key, not a payload or credential. `TenantRequestLedger` persists bounded scalar
admission records and filters them by tenant. Ledger failure is observability-only and cannot fail
the admitted data-plane request. Full usage aggregation and management-plane projection remain
separate implementation rows below and are not claimed by this slice.

## Explicit remaining rows

- [x] Versioned tenant identity/admission type and dedicated credential channel.
- [x] Negative cross-tenant admission/model tests.
- [x] Tenant admission before every `/v1/*` dispatch and WebSocket upgrade.
- [x] Tenant-filtered `/v1/models` projection for all three catalog shapes.
- [x] Tenant-scoped request-history key primitive.
- [x] Bounded tenant request ledger with atomic writes and tenant filtering.
- [x] Durable versioned operator policy file with duplicate-safe save and key rotation.
- [ ] Operator configuration persistence and rotation.
- [ ] Tenant-attributed usage aggregation and operator filtering.
- [ ] Tenant account-pool, affinity, quota, and concurrency isolation.
- [ ] Trusted-proxy identity contract and centrally hosted deployment guide.

The unchecked rows are intentional. Closing #95 requires those rows plus cross-tenant acceptance
through every inference and management boundary; this commit does not make that claim.
