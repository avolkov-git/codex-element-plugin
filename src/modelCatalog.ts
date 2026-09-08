import { ModelOption } from "./types";

export interface ModelCatalogSnapshot {
  options: ModelOption[];
  status: "idle" | "loading" | "ready" | "error";
}

/** Stale requests must not repopulate the catalog of a new runtime/account. */
export class ModelCatalog {
  private snapshot: ModelCatalogSnapshot = { options: [], status: "idle" };
  private loadedAt = 0;
  private generation = 0;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly fetchOptions: () => Promise<ModelOption[]>,
    private readonly onChange: (snapshot: ModelCatalogSnapshot) => void,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  load(forceReload = false): Promise<void> {
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
    }).catch((error: unknown) => {
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

  invalidate(): void {
    this.generation += 1;
    this.pending = undefined;
    this.loadedAt = 0;
    this.snapshot = { options: [], status: "idle" };
    this.onChange(this.snapshot);
  }

  private publish(status: ModelCatalogSnapshot["status"]): void {
    this.snapshot = { ...this.snapshot, status };
    this.onChange(this.snapshot);
  }
}
