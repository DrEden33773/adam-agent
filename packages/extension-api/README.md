# @adam-agent/extension-api

Public, schema-library-neutral contracts for trusted first-party Adam Agent extensions.

Version `0.3.0` adds pure-data command, project-change input-source and report descriptors plus the strict bounded `adam.project-change-snapshot@1` contract. Version `0.2.0` added bounded read-only operation reconciliation to the first supported `0.1.0` contract. Earlier version `0.0.0-bootstrap.0` established the npm package identity and is deprecated; do not depend on it. Releases are staged from an exact product tag through npm Trusted Publishing before human approval.

The package defines static manifest parsing, capability identifiers and bounds, operation contexts and events, artifact summaries, immutable namespaced records, bounded operation-scoped reconciliation evidence, and the fixed-profile Biome analyzer contract. Reconciliation can only read exact immutable record or artifact evidence and cannot resume `execute`, publish, report progress, access ordinary operation capabilities, or perform workspace, process, network, model, or managed-session effects. The package does not export Adam runtime implementations, stores, provider access, raw filesystem or process handles, model-facing tools, or a global host.

The optional `project_changes@1` descriptor is admissible only with exact operation input contract `adam.project-change-snapshot@1`. That eager browser-neutral value contains one Git capture-policy identity, an exact committed or unborn base, a captured candidate tree, deterministic unified diff, bounded strict-UTF-8 source sides, explicit binary/symlink/gitlink unavailability facts and digests. It grants no later filesystem access, URI, listing, callback, renderer or cross-operation handle.

Extension packages declare required and optional capabilities in `package.json.adamAgent`. Adam validates the locked package identity and manifest before importing the runtime, then injects only declared, available, compatible, and granted handles into each operation context.

Capability grants do not authorize external effects. The Biome execution broker also requires a per-operation `PermissionPolicy` allow decision, and its process, snapshot, report, stdout, stderr, deadline, cancellation, and provenance remain Host-owned. Artifact summaries already published by an operation may appear on completed, failed, or cancelled terminal events.

This interface is designed for trusted in-process code and is not a security sandbox.
