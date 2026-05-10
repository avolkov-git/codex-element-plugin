"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerfMarks = void 0;
class PerfMarks {
    constructor() {
        this.started = Date.now();
        this.marks = [];
        this.last = this.started;
    }
    mark(name) {
        const now = Date.now();
        this.marks.push({ name, at: now - this.started, duration: now - this.last });
        this.last = now;
    }
    flush(logger, prefix) {
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
exports.PerfMarks = PerfMarks;
//# sourceMappingURL=performance.js.map