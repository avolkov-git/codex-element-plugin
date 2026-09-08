"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelCatalog = void 0;
/** Stale requests must not repopulate the catalog of a new runtime/account. */
class ModelCatalog {
    constructor(fetchOptions, onChange, onError, now = Date.now, ttlMs = 5 * 60 * 1000) {
        this.fetchOptions = fetchOptions;
        this.onChange = onChange;
        this.onError = onError;
        this.now = now;
        this.ttlMs = ttlMs;
        this.snapshot = { options: [], status: "idle" };
        this.loadedAt = 0;
        this.generation = 0;
    }
    load(forceReload = false) {
        if (this.pending) {
            return this.pending;
        }
        if (!forceReload && this.snapshot.status === "ready" && this.now() - this.loadedAt < this.ttlMs) {
            return Promise.resolve();
        }
        const generation = this.generation;
        this.publish("loading");
        const request = Promise.resolve().then(this.fetchOptions).then((options) => {
            if (generation !== this.generation) {
                return;
            }
            if (!options.some((option) => option.id !== null)) {
                throw new Error("model/list returned no usable models");
            }
            this.loadedAt = this.now();
            this.snapshot = { options, status: "ready" };
            this.onChange(this.snapshot);
        }).catch((error) => {
            if (generation === this.generation) {
                this.onError(error);
                this.publish("error");
            }
        }).finally(() => {
            if (this.pending === request) {
                this.pending = undefined;
            }
        });
        this.pending = request;
        return request;
    }
    invalidate() {
        this.generation += 1;
        this.pending = undefined;
        this.loadedAt = 0;
        this.snapshot = { options: [], status: "idle" };
        this.onChange(this.snapshot);
    }
    publish(status) {
        this.snapshot = { ...this.snapshot, status };
        this.onChange(this.snapshot);
    }
}
exports.ModelCatalog = ModelCatalog;
//# sourceMappingURL=modelCatalog.js.map