/**
 * Background task scheduling. POST /api/lessons returns 202 immediately and lets
 * generation continue in the background (research R6). Production fires-and-forgets;
 * tests use a deterministic scheduler that can be awaited.
 */
export interface TaskScheduler {
  schedule(task: () => Promise<void>): void;
}

export const fireAndForgetScheduler: TaskScheduler = {
  schedule(task) {
    void task().catch(() => {
      /* failures are persisted as lesson status `failed`; nothing to do here */
    });
  },
};

/** Deterministic scheduler for tests: collects task promises so they can be settled. */
export class CollectingScheduler implements TaskScheduler {
  private tasks: Promise<void>[] = [];

  schedule(task: () => Promise<void>): void {
    this.tasks.push(task());
  }

  async settle(): Promise<void> {
    await Promise.all(this.tasks);
    this.tasks = [];
  }
}
