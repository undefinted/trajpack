import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopbackReviewApi, ReviewApiError } from "./client.js";

describe("LoopbackReviewApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds CSRF, no-store, and same-origin credentials to writes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        api_version: "review/0.1",
        csrf_token: "csrf-123",
        server_version: "0.1.0",
        vault: { state: "unlocked", idle_lock_at: null },
      }))
      .mockResolvedValueOnce(jsonResponse({ revision: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new LoopbackReviewApi("/api/v1/review", "test-reviewer-token");
    await api.updateEvent("trace/with spaces", "event/1", {
      expected_revision: 1,
      disposition: "exclude",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/review/traces/trace%2Fwith%20spaces/events/event%2F1",
      expect.objectContaining({
        method: "PATCH",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        headers: expect.objectContaining({
          "X-Trajpack-CSRF": "csrf-123",
          "X-Trajpack-Reviewer-Token": "test-reviewer-token",
          "X-Requested-With": "trajpack-reviewer",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("retries a rejected bootstrap instead of caching the failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({
        api_version: "review/0.1",
        csrf_token: "csrf-2",
        server_version: "0.1.0",
        vault: { state: "unlocked", idle_lock_at: null },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new LoopbackReviewApi("/api/v1/review", "test-reviewer-token");
    await expect(api.bootstrap()).rejects.toThrow();
    await expect(api.bootstrap()).resolves.toMatchObject({ csrf_token: "csrf-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces structured server errors without rendering server HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: "revision_conflict", message: "Trace changed" } },
      409,
    )));
    const api = new LoopbackReviewApi("/api/v1/review", "test-reviewer-token");
    await expect(api.getTrace("abc")).rejects.toEqual(
      expect.objectContaining<Partial<ReviewApiError>>({
        name: "ReviewApiError",
        status: 409,
        code: "revision_conflict",
        message: "Trace changed",
      }),
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
