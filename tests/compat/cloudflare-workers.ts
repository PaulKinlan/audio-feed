/**
 * Minimal Node/Vitest test shim for `cloudflare:workers` and `cloudflare:workflows`.
 * Allows Vitest suites to import `src/worker_entry.ts` and unit-test `WorkflowEntrypoint`
 * classes directly without requiring the workerd runtime.
 */

export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  abstract run(event: Readonly<{ payload: Params; instanceId: string; timestamp: Date }>, step: unknown): Promise<unknown>;
}

export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") {
    super(message);
    this.name = name;
  }
}
