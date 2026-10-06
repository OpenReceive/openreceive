/** Limits how many jobs hold a slot. Releasing a slot wakes one waiter. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    if (size < 1) throw new Error("A semaphore needs at least one slot.");
    this.available = size;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.available += 1;
  }
}

export interface Job {
  readonly heavy: boolean;
  readonly run: () => Promise<void>;
}

/**
 * Run jobs together. `parallel` is the cap for every job. `heavyParallel` is a
 * second cap for shops that bring their own database, so two WordPress stacks
 * can run while a later BTCPay stack waits.
 */
export async function runPool(
  jobs: readonly Job[],
  parallel: number,
  heavyParallel: number,
): Promise<void> {
  const overall = new Semaphore(parallel);
  const heavy = new Semaphore(heavyParallel);
  const errors: unknown[] = [];

  await Promise.all(
    jobs.map(async (job) => {
      await overall.acquire();
      if (job.heavy) await heavy.acquire();
      try {
        await job.run();
      } catch (error) {
        errors.push(error);
      } finally {
        if (job.heavy) heavy.release();
        overall.release();
      }
    }),
  );

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} runs failed.`);
  }
}
