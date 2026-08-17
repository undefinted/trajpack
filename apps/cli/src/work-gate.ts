export type WorkRelease = () => void;

/**
 * Small FIFO admission gate for memory-intensive local work. It bounds both
 * active operations and retained waiters, and transfers a released slot
 * directly to the oldest waiter so active accounting cannot briefly overshoot.
 */
export class BoundedWorkGate {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: WorkRelease | null) => void;
    signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }> = [];

  constructor(
    readonly maxActive: number,
    readonly maxQueued: number,
  ) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new Error("Work gate maxActive must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Work gate maxQueued must be a non-negative safe integer");
    }
  }

  acquire(signal?: AbortSignal): Promise<WorkRelease | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.releaseLease());
    }
    if (this.waiters.length >= this.maxQueued) return Promise.resolve(null);
    return new Promise<WorkRelease | null>((resolve) => {
      const waiter: (typeof this.waiters)[number] = { resolve, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          resolve(null);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  snapshot(): Readonly<{ active: number; queued: number }> {
    return { active: this.active, queued: this.waiters.length };
  }

  private releaseLease(): WorkRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const next = this.waiters.shift();
        if (!next) {
          this.active -= 1;
          return;
        }
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          next.resolve(null);
          continue;
        }
        next.resolve(this.releaseLease());
        return;
      }
    };
  }
}
