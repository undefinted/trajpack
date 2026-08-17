import type { TrajectoryEvent } from "@trajpack/schema";

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
