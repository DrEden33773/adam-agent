# @adam-agent/extension-api

Public contracts and runtime codecs for trusted first-party Adam Agent extensions.

The `0.6.0` source API adds the purpose-specific, operation-scoped `adam.managed-review@1` capability. An extension negotiates `>=0.6.0 <0.7.0`, requires and receives a grant for the exact capability, and calls `review(request)`. Same-digest calls join the same run; a different second request conflicts. Host-generated `reviewRunId` and request digest are durable before managed admission.

A request contains immutable evidence references, a short instruction, the exact contribution-registered `outputContract`, and an optional tighter cumulative token ceiling. It contains no target, model, role, tool list, deadline control, Fleet handle, workspace root, store, or cancellation handle. The Host resolves the exact origin configuration, revalidates it at execution-slot acquisition, and runs a fresh non-interactive reviewer with no tools or Skills.

| Bound | Contract |
| --- | --- |
| Evidence | 1–8 exact operation-owned artifact or record references; at most 12 MiB of validated evidence |
| Instruction | Nonblank, well-formed UTF-8; at most 16 KiB |
| Result | Registered-codec-valid JSON; at most 1 MiB after encoding, independent of internal inline limits |
| Ordinary Operation | Default 60 seconds; public maximum 5 minutes |
| Review execution | Default and maximum 30 minutes from actual slot acquisition; versioned Host policy may only shorten it |
| Inactivity and cleanup | Separate existing inactivity guards; managed inactivity is 5 minutes, and cleanup has its own 10-second bound |

`extensionManagedReviewRequestCodec`, `extensionManagedReviewTerminalCodec`, and `extensionManagedReviewProgressCodec` export the wire validation used by the Host. Matching `EXTENSION_MANAGED_REVIEW_*` constants export the capability bounds. Evidence uses the existing public reference types, including readonly reference arrays. The codecs reject non-JSON values, malformed Unicode, unknown fields and unsupported failure classes.

Inside an operation that declares and registers `example.findings@1` as its `managedOutput`:

```ts
import {
  EXTENSION_MANAGED_REVIEW_CAPABILITY_ID,
  extensionManagedReviewRequestCodec,
  extensionManagedReviewTerminalCodec,
  type ExtensionOperationContext,
  type ExtensionOperationEvidenceReference,
} from "@adam-agent/extension-api";

export async function reviewEvidence(
  operation: ExtensionOperationContext,
  evidence: readonly ExtensionOperationEvidenceReference[],
) {
  const capability = operation.capabilities[EXTENSION_MANAGED_REVIEW_CAPABILITY_ID];
  if (capability === undefined) throw new Error("Managed review is unavailable.");

  const request = extensionManagedReviewRequestCodec.decode({
    evidence,
    instruction: "Review the supplied evidence and return findings.",
    outputContract: { id: "example.findings", version: 1 },
  });
  if (!request.ok) throw new Error("Invalid review request.");

  const result = extensionManagedReviewTerminalCodec.decode(
    await capability.review(request.value),
  );
  if (!result.ok) throw new Error("Invalid review terminal.");
  return result.value;
}
```

Success returns the decoded result and a receipt containing `reviewRunId`, resolved policy digest and target identity, evidence-set digest, output contract/digest/serialized size, trace digest, and input/output/reasoning/turn usage. The Host materializes artifact-backed output and persists the encoded result under its receipt digest. Returned values are detached from the Host's authoritative cached result. The receipt contains no internal thread or attempt IDs and no permanently unavailable cost field.

Admission failures are `invalid_request`, `policy_denied`, `target_unavailable`, or `capacity_expired`. Execution failures are `model_failed`, `stalled`, `budget_exhausted`, `output_invalid`, `review_deadline_exceeded`, or `recovery_required`. Available partial output, trace and usage remain attached to incomplete results. Unknown internal failures remain sanitized Operation failures.

The Host durably projects `waiting_for_capacity`, `running`, `settling`, and `terminal`. Queued review shares the reserved foreground/reviewer lane and consumes ordinary Operation time; queue admission does not pause that clock. Capacity expiry cancels and settles the review before the outer Operation reports its exhausted deadline. Actual slot acquisition pauses ordinary time and starts the separate total review deadline. Progress does not reset that total. Outcome persistence ends execution accounting; ordinary remaining time resumes after claim release and managed settlement. Cleanup that cannot settle remains explicitly inspection-required with retained evidence and reservations.

Cancellation belongs to the enclosing Operation and is independent of review failure classes. An extension cannot bypass settlement by returning without awaiting its review. Cold recovery retains the exact invocation and never automatically replays the extension or provider. Explicit cold cancellation can cancel or finish cleanup of the existing run; unknown provider usage remains reserved rather than being refunded as zero. Reviewers are isolated from ordinary Agent handles, controls and Main completion delivery.

The package also retains supported historical `0.3.0`, `0.4.0`, and `0.5.0` contracts. The ordinary CLI currently uses the existing managed-session consumer integration; the new managed-review Host path is exercised through the internal candidate composition until the coordinated consumer cutover. Neither the API version bump nor package publication performs that switch.

The optional `project_changes@1` descriptor requires exact input contract `adam.project-change-snapshot@1`. It carries a bounded immutable Git capture, source sides, explicit unavailable entries and digests, with no later filesystem authority. One contribution registers its exact input, output, progress and optional managed-output codecs; there is no general per-call schema registry. Ordinary reconciliation is bounded and read-only.

Releases use the exact `extension-api-v<version>` tag at freshly fetched product `main`, a clean checkout, full Quality, and npm Trusted Publishing staging. The verifier checks the actual tag target, GitHub SHA and fetched main, and the workflow rechecks main after Quality. Final npm publication remains a separate human approval step. Source version and a local tarball are not registry publication evidence.

Adam validates locked package identity, manifest compatibility and capability grants before runtime import. This interface is for trusted in-process JavaScript and is not a security sandbox.
