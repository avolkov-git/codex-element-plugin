import { Logger } from "./logger";

export class PerfMarks {
  private readonly started = Date.now();
  private readonly marks: Array<{ name: string; at: number; duration: number }> = [];
  private last = this.started;

  mark(name: string): void {
    const now = Date.now();
    this.marks.push({ name, at: now - this.started, duration: now - this.last });
    this.last = now;
  }

  flush(logger: Logger, prefix: string): void {
    const total = Date.now() - this.started;
    const timings = this.marks.map((mark) => `${mark.name}=${mark.duration}ms`).join(", ");
    logger.info(`${prefix} completed in ${total}ms${timings ? ` (${timings})` : ""}`);
    for (const mark of this.marks) {
      if (mark.duration >= 1000) {
        logger.warn(`${prefix} slow step: ${mark.name} took ${mark.duration}ms`);
      }
    }
  }
}

