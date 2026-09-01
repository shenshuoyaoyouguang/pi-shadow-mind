import type { ShadowReport } from "./types.js";

/** A snapshot enqueued by flush(); clear() can still cancel it before delivery starts. */
interface PendingBatch {
  reports: ShadowReport[];
  dropped: boolean;
  started: boolean;
}

export class ReportBatcher {
  private reports: ShadowReport[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private deliveries = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<PendingBatch>();

  constructor(private windowMs: number, private readonly deliver: (reports: ShadowReport[]) => void | Promise<void>) {}

  setWindow(windowMs: number): void {
    this.windowMs = windowMs;
  }

  add(report: ShadowReport): void {
    this.reports.push(report);
    if (this.timer) return;
    // Delivery failures are contained here: a fire-and-forget timer callback
    // must not leak an unhandled rejection into the host process.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, this.windowMs);
  }

  /** Serialized: at most one delivery is in flight at any time. Each flush
   * delivers only the reports pending when it was called (the timer is cleared
   * synchronously), so a queued flush cannot cancel a newer report's window.
   * The delivery is counted from enqueue so hasPending has no gap between the
   * flush call and the delivery actually starting. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.reports;
    this.reports = [];
    if (!batch.length) return this.queue;
    const box: PendingBatch = { reports: batch, dropped: false, started: false };
    this.pending.add(box);
    this.deliveries += 1;
    const run = this.queue.then(() => this.deliverBatch(box));
    this.queue = run.catch(() => {});
    return run;
  }

  private async deliverBatch(box: PendingBatch): Promise<void> {
    box.started = true;
    try {
      if (!box.dropped) await this.deliver(box.reports);
    } finally {
      this.pending.delete(box);
      this.deliveries -= 1;
    }
  }

  get hasPending(): boolean {
    return this.reports.length > 0 || this.timer !== undefined || this.deliveries > 0;
  }

  clear(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let dropped = this.reports.length;
    this.reports = [];
    // Queued-but-unstarted snapshots are still pending reports: cancel them
    // and count them so callers do not under-report what was thrown away.
    // Batches already inside deliver() cannot be recalled here; the runtime's
    // epoch filtering drops those at send time.
    for (const box of this.pending) {
      if (box.started) continue;
      box.dropped = true;
      dropped += box.reports.length;
    }
    this.pending.clear();
    return dropped;
  }
}

export function formatReportBatch(reports: readonly ShadowReport[]): string {
  return reports.map((report) => `[${report.shadowName} / ${report.shadowId}]\n${report.content}`).join("\n\n");
}
