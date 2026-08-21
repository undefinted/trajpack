import type { TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { canonicalJson, sha256 } from "./canonical.js";
import { approvalFingerprint } from "./policy.js";

export interface ExcludedContentPart {
  eventId: string;
  ordinal: number;
  reason: string;
}

/**
 * A canonical tool event carries the same payload twice: once as a reviewed
 * ContentPart and once in the structured `tool` projection used by ATIF/HF.
 * Excluding either reviewed projection must exclude the whole tool event;
 * otherwise the structured copy would silently bypass the review decision.
 */
export function structuredToolProjectionExcluded(
  event: TrajectoryEvent,
  excludedContentKeys: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (event.tool === null || (event.event_type !== "tool.call" && event.event_type !== "tool.result")) {
    return false;
  }
  const projectionType = event.event_type === "tool.call" ? "tool_call" : "tool_result";
  const projections = event.content.filter((part) => part.type === projectionType);
  return projections.some((part) => part.review_disposition !== "include"
    || excludedContentKeys.has(`${event.event_id}\0${part.ordinal}`));
}

/**
 * Build the exact policy/review-selected canonical view used by every
 * plaintext exporter. Keeping this pass shared also lets dataset planning
 * preflight the same versioned training recipe that export will compile.
 */
export function selectExportView(
  bundle: TraceBundle,
  excluded: readonly ExcludedContentPart[] = [],
): TraceBundle {
  const excludedKeys = new Set(excluded.map((part) => `${part.eventId}\0${part.ordinal}`));
  const selectedEvents = bundle.events
    .filter((event) => event.review_disposition === "include")
    .filter((event) => !structuredToolProjectionExcluded(event, excludedKeys))
    .map((event) => ({
      ...event,
      content: event.content
        .filter((part) => part.review_disposition === "include")
        .filter((part) => !excludedKeys.has(`${event.event_id}\0${part.ordinal}`)),
    }));
  const wasRedacted = (event: TrajectoryEvent): boolean => {
    const review = event.metadata.trajpack_review;
    return event.content.some((part) => part.redaction_status === "redacted")
      || event.metadata.trajpack_structured_redaction !== undefined
      || (typeof review === "object" && review !== null
        && (review as Record<string, unknown>).disposition === "redact");
  };
  const redactedSpans = new Map<string, string>();
  for (const event of selectedEvents.filter(wasRedacted)) {
    redactedSpans.set(event.span_id, sha256(canonicalJson({
      scope: "redacted-span",
      trace_id: event.trace_id,
      sequence: event.sequence,
      event_type: event.event_type,
      actor: event.actor,
    })).slice(0, 16));
  }
  const events = selectedEvents.map((event) => {
    const rekey = redactedSpans.has(event.span_id);
    const metadata = { ...event.metadata };
    if (rekey) {
      delete metadata.raw_payload_sha256;
      delete metadata.payload_sha256;
      delete metadata.payload_preview_hash;
    }
    return {
      ...event,
      ...(rekey ? {
        event_id: `redacted:${sha256(canonicalJson({
          scope: "redacted-event",
          trace_id: event.trace_id,
          sequence: event.sequence,
          event_type: event.event_type,
          actor: event.actor,
        })).slice(0, 32)}`,
        source_event_id: null,
      } : {}),
      span_id: redactedSpans.get(event.span_id) ?? event.span_id,
      parent_span_id: event.parent_span_id === null
        ? null
        : redactedSpans.get(event.parent_span_id) ?? event.parent_span_id,
      links: event.links.map((link) => ({
        ...link,
        span_id: redactedSpans.get(link.span_id) ?? link.span_id,
      })),
      metadata,
    };
  });
  const selected: TraceBundle = {
    ...bundle,
    manifest: redactedSpans.size > 0 ? {
      ...bundle.manifest,
      lineage: { ...bundle.manifest.lineage, raw_sha256: null },
    } : bundle.manifest,
    raw: [],
    events,
  };
  const sourceApproval = bundle.manifest.review.approval_scope;
  if (sourceApproval !== null) {
    selected.manifest = {
      ...selected.manifest,
      review: {
        ...selected.manifest.review,
        approval_scope: {
          ...sourceApproval,
          approved_source_bundle_sha256: sourceApproval.approved_source_bundle_sha256 ?? sourceApproval.bundle_sha256,
          export_pass_version: "export-view/0.1",
          bundle_sha256: approvalFingerprint(selected),
        },
      },
    };
    // approvalFingerprint excludes review, so this stays stable after the
    // derived-view attestation is attached.
    selected.manifest.review.approval_scope!.bundle_sha256 = approvalFingerprint(selected);
  }
  return selected;
}
