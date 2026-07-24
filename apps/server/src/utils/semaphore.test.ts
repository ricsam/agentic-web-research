import { describe, expect, it } from "bun:test";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
  it("rejects immediately when saturated through tryRun", async () => {
    const semaphore = new Semaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(await semaphore.tryRun(async () => "never")).toEqual({ accepted: false });
    semaphore.release();
  });

  it("removes aborted work from the wait queue", async () => {
    const semaphore = new Semaphore(1);
    expect(semaphore.tryAcquire()).toBe(true);
    const controller = new AbortController();
    const queued = semaphore.run(async () => "ran", controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(queued).rejects.toThrow("cancelled");
    semaphore.release();
    expect(semaphore.activeCount).toBe(0);
  });
});
