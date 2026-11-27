import { vi } from "vitest";

export class FakeTime {
  constructor(now?: number | string | Date) {
    vi.useFakeTimers();
    if (now !== undefined) {
      vi.setSystemTime(now);
    }
  }

  tick(ms: number): void {
    vi.advanceTimersByTime(ms);
  }

  async tickAsync(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  restore(): void {
    vi.useRealTimers();
  }

  [Symbol.dispose](): void {
    this.restore();
  }
}
