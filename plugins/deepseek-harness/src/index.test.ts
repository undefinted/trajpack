import { describe, expect, it, vi } from "vitest";

import { apply, harnessCompatibility, name } from "./index.js";

describe("DeepSeek Harness plugin", () => {
  it("subscribes exactly once to the durable session/event channel", async () => {
    let listener: ((...args: unknown[]) => void) | null = null;
    const on = vi.fn((event: "session/event", callback: (...args: unknown[]) => void) => {
      expect(event).toBe("session/event");
      listener = callback;
    });

    apply({ on });
    expect(name).toBe("trajpack");
    expect(harnessCompatibility).toBe("0.1.0-rc.6");
    expect(on).toHaveBeenCalledTimes(1);

    delete process.env.TRAJPACK_COLLECTOR_URL;
    delete process.env.TRAJPACK_CAPTURE_TOKEN;
    expect(listener).not.toBeNull();
    (listener as (...args: unknown[]) => void)({ type: "turn/start", session_id: "test" });
    await Promise.resolve();
  });
});
