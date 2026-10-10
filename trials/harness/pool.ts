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
  /** Jobs with the same key run one at a time: they share something outside this machine. */
  readonly serial?: string;
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
  const serials = new Map<string, Semaphore>();
  const serialFor = (key: string): Semaphore => {
    const found = serials.get(key) ?? new Semaphore(1);
    serials.set(key, found);
    return found;
  };
  const errors: unknown[] = [];

  await Promise.all(
    jobs.map(async (job) => {
      // Wait for the serial key before taking a slot, so a queued job holds none.
      const own = job.serial === undefined ? undefined : serialFor(job.serial);
      await own?.acquire();
      await overall.acquire();
      if (job.heavy) await heavy.acquire();
      try {
        await job.run();
      } catch (error) {
        errors.push(error);
      } finally {
        if (job.heavy) heavy.release();
        overall.release();
        own?.release();
      }
    }),
  );

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} runs failed.`);
  }
}
