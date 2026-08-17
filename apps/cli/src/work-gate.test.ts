import { describe, expect, it } from "vitest";
import { BoundedWorkGate } from "./work-gate.js";

describe("bounded work gate", () => {
  it("admits FIFO work without oversubscription and rejects beyond the queue bound", async () => {
    const gate = new BoundedWorkGate(2, 2);
    const first = await gate.acquire();
    const second = await gate.acquire();
    const order: number[] = [];
    const third = gate.acquire().then((release) => { order.push(3); return release; });
    const fourth = gate.acquire().then((release) => { order.push(4); return release; });
    expect(await gate.acquire()).toBeNull();
    expect(gate.snapshot()).toEqual({ active: 2, queued: 2 });

    first!();
    const thirdRelease = await third;
    expect(order).toEqual([3]);
    expect(gate.snapshot()).toEqual({ active: 2, queued: 1 });
    thirdRelease!();
    const fourthRelease = await fourth;
    expect(order).toEqual([3, 4]);

    // Releases are idempotent and cannot underflow active accounting.
    first!();
    second!();
    fourthRelease!();
    fourthRelease!();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("validates hard bounds", () => {
    expect(() => new BoundedWorkGate(0, 1)).toThrow("maxActive");
    expect(() => new BoundedWorkGate(1, -1)).toThrow("maxQueued");
  });

  it("cancels abandoned waiters without leaking or reordering active leases", async () => {
    const gate = new BoundedWorkGate(1, 2);
    const active = await gate.acquire();
    const abandoned = new AbortController();
    const cancelled = gate.acquire(abandoned.signal);
    const next = gate.acquire();
    expect(gate.snapshot()).toEqual({ active: 1, queued: 2 });
    abandoned.abort();
    await expect(cancelled).resolves.toBeNull();
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1 });
    active!();
    const nextRelease = await next;
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });
    nextRelease!();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
