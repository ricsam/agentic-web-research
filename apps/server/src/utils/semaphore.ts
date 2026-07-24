export class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    start: () => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(private readonly max: number) {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  async tryRun<T>(work: () => Promise<T>): Promise<{ accepted: true; value: T } | { accepted: false }> {
    if (!this.tryAcquire()) {
      return { accepted: false };
    }

    try {
      return { accepted: true, value: await work() };
    } finally {
      this.release();
    }
  }

  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  acquire(signal?: AbortSignal) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    }
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const queued: (typeof this.queue)[number] = {
        signal,
        start: () => {
          if (queued.abort) signal?.removeEventListener("abort", queued.abort);
          this.active += 1;
          resolve();
        }
      };
      if (signal) {
        queued.abort = () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
        };
        signal.addEventListener("abort", queued.abort, { once: true });
      }
      this.queue.push(queued);
    });
  }

  release() {
    if (this.active <= 0) {
      throw new Error("Semaphore released without a matching acquisition");
    }
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next.start();
  }

  get activeCount() {
    return this.active;
  }

  get capacity() {
    return this.max;
  }
}
