import type {
  EventReviewPatch,
  EventRightsPatch,
  EventVerifierPatch,
  ExportPreview,
  ExportPreviewRequest,
  ExportReceipt,
  ExportRequest,
  ReviewApi,
  ReviewerBootstrap,
  TraceDecisionRequest,
  TraceDetail,
  TraceListResponse,
  TraceSummary,
} from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ReviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

export class LoopbackReviewApi implements ReviewApi {
  private bootstrapResult: Promise<ReviewerBootstrap> | null = null;

  constructor(
    private readonly basePath = "/api/v1/review",
    private readonly reviewerToken = reviewerTokenFromFragment(),
  ) {
    assertLoopbackOrigin();
    if (!reviewerToken) throw new Error("Reviewer launch capability is missing");
  }

  bootstrap(): Promise<ReviewerBootstrap> {
    // Do not cache a rejected bootstrap: a transient failure must not poison
    // every later call until the page is reloaded.
    if (this.bootstrapResult === null) {
      this.bootstrapResult = this.request<ReviewerBootstrap>("/bootstrap", { method: "GET" }, false)
        .catch((error: unknown) => {
          this.bootstrapResult = null;
          throw error;
        });
    }
    return this.bootstrapResult;
  }

  async listTraces(): Promise<TraceSummary[]> {
    const result = await this.request<TraceListResponse>("/traces", { method: "GET" }, false);
    return result.traces;
  }

  getTrace(traceId: string): Promise<TraceDetail> {
    return this.request<TraceDetail>(`/traces/${encodeURIComponent(traceId)}`, { method: "GET" }, false);
  }

  updateEvent(traceId: string, eventId: string, patch: EventReviewPatch): Promise<TraceDetail> {
    return this.write<TraceDetail>(
      `/traces/${encodeURIComponent(traceId)}/events/${encodeURIComponent(eventId)}`,
      "PATCH",
      patch,
    );
  }

  updateEventRights(traceId: string, eventId: string, patch: EventRightsPatch): Promise<TraceDetail> {
    return this.write<TraceDetail>(
      `/traces/${encodeURIComponent(traceId)}/events/${encodeURIComponent(eventId)}/rights`,
      "PATCH",
      patch,
    );
  }

  updateEventVerifier(traceId: string, eventId: string, patch: EventVerifierPatch): Promise<TraceDetail> {
    return this.write<TraceDetail>(
      `/traces/${encodeURIComponent(traceId)}/events/${encodeURIComponent(eventId)}/verifier`,
      "PATCH",
      patch,
    );
  }

  decideTrace(traceId: string, request: TraceDecisionRequest): Promise<TraceDetail> {
    return this.write<TraceDetail>(
      `/traces/${encodeURIComponent(traceId)}/decision`,
      "POST",
      request,
    );
  }

  previewExport(traceId: string, request: ExportPreviewRequest): Promise<ExportPreview> {
    return this.write<ExportPreview>(
      `/traces/${encodeURIComponent(traceId)}/export-preview`,
      "POST",
      request,
    );
  }

  exportTrace(traceId: string, request: ExportRequest): Promise<ExportReceipt> {
    return this.write<ExportReceipt>(`/traces/${encodeURIComponent(traceId)}/exports`, "POST", request);
  }

  private async write<T>(path: string, method: "PATCH" | "POST", body: unknown): Promise<T> {
    const bootstrap = await this.bootstrap();
    return this.request<T>(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Trajpack-CSRF": bootstrap.csrf_token,
        },
        body: JSON.stringify(body),
      },
      true,
    );
  }

  private async request<T>(path: string, init: RequestInit, isWrite: boolean): Promise<T> {
    const url = `${this.basePath}${path}`;
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-Trajpack-Reviewer-Token": this.reviewerToken,
        ...(isWrite ? { "X-Requested-With": "trajpack-reviewer" } : {}),
        ...init.headers,
      },
      redirect: "error",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const errorPayload = isErrorPayload(payload) ? payload : null;
      throw new ReviewApiError(
        errorPayload?.error.message ?? `Reviewer API request failed (${response.status})`,
        response.status,
        errorPayload?.error.code ?? "request_failed",
      );
    }

    return payload as T;
  }
}

function reviewerTokenFromFragment(): string {
  if (typeof window === "undefined") return "non-browser-test-token";
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("reviewer_token") ?? "";
}

function assertLoopbackOrigin(): void {
  if (typeof window === "undefined") return;
  if (!LOOPBACK_HOSTS.has(window.location.hostname)) {
    throw new Error("trajpack reviewer must be served from a loopback origin");
  }
}

function isErrorPayload(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  );
}

export async function createReviewApi(): Promise<ReviewApi> {
  if (import.meta.env.DEV && import.meta.env.VITE_REVIEW_USE_MOCKS !== "false") {
    const { MockReviewApi } = await import("../mocks/reviewApi.js");
    return new MockReviewApi();
  }
  return new LoopbackReviewApi();
}
