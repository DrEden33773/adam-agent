# @adam-agent/extension-api

Public, schema-library-neutral contracts for trusted first-party Adam Agent extensions.

Version `0.1.0` is the first supported consumer release. Earlier version `0.0.0-bootstrap.0` established the npm package identity and is deprecated; do not depend on it. Releases are staged from an exact product tag through npm Trusted Publishing before human approval.

The package defines static manifest parsing, capability identifiers and bounds, operation contexts and events, artifact summaries, immutable namespaced records, and the fixed-profile Biome analyzer contract. It does not export Adam runtime implementations, stores, provider access, raw filesystem or process handles, model-facing tools, or a global host.

Extension packages declare required and optional capabilities in `package.json.adamAgent`. Adam validates the locked package identity and manifest before importing the runtime, then injects only declared, available, compatible, and granted handles into each operation context.

Capability grants do not authorize external effects. The Biome execution broker also requires a per-operation `PermissionPolicy` allow decision, and its process, snapshot, report, stdout, stderr, deadline, cancellation, and provenance remain Host-owned. Artifact summaries already published by an operation may appear on completed, failed, or cancelled terminal events.

This interface is designed for trusted in-process code and is not a security sandbox.
