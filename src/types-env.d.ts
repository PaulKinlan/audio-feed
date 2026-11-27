// Ambient types for Cloudflare Workers build & shared Deno-compatible modules.

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "../assets/listen.js" {
  const content: string;
  export default content;
}
declare module "../assets/listen-landing.js" {
  const content: string;
  export default content;
}
declare module "../assets/admin.js" {
  const content: string;
  export default content;
}
declare module "../assets/same-origin-path.js" {
  const content: string;
  export default content;
}
declare module "../assets/confirm-shared.js" {
  const content: string;
  export default content;
}
declare module "../assets/home.js" {
  const content: string;
  export default content;
}
declare module "../assets/cwv-stats.js" {
  const content: string;
  export default content;
}
declare module "../assets/cwv.js" {
  const content: string;
  export default content;
}
declare module "../assets/tooltip-client.js" {
  const content: string;
  export default content;
}

interface URLPatternResult {
  pathname: { groups: Record<string, string | undefined> };
}

interface URLPattern {
  exec(input: string | URL | { pathname?: string }): URLPatternResult | null;
}

declare var URLPattern: {
  new (init: { pathname?: string }): URLPattern;
};

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  noRetry(): void;
}

interface WorkflowEvent<P = unknown> {
  readonly payload: P;
  readonly timestamp: Date;
  readonly instanceId: string;
}

interface WorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  retry(options?: { delaySeconds?: number }): void;
  ack(): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  retryAll(options?: { delaySeconds?: number }): void;
  ackAll(): void;
}

declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;
    constructor(ctx: ExecutionContext, env: Env);
    run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<unknown>;
  }
}

declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}

declare namespace Temporal {
  interface ZonedDateTime {
    dayOfWeek: number;
    day: number;
    month: number;
    year: number;
    hour: number;
    minute: number;
    second: number;
  }
  interface Instant {
    toZonedDateTimeISO(tz: string): ZonedDateTime;
  }
  const Instant: {
    from(iso: string): Instant;
    compare(a: Instant, b: Instant): number;
  };
  interface PlainDate {
    toString(): string;
  }
  const PlainDate: {
    from(iso: string): PlainDate;
  };
}

declare namespace Deno {
  type KvKeyPart = Uint8Array | string | number | bigint | boolean;
  type KvKey = readonly KvKeyPart[];
  interface KvU64 {
    readonly value: bigint;
  }
  interface KvEntry<T> {
    key: KvKey;
    value: T;
    versionstamp: string;
  }
  interface KvEntryMaybe<T> {
    key: KvKey;
    value: T | null;
    versionstamp: string | null;
  }
  interface AtomicOperation {
    check(...checks: { key: KvKey; versionstamp: string | null }[]): AtomicOperation;
    set(key: KvKey, value: unknown, options?: { expireIn?: number }): AtomicOperation;
    delete(key: KvKey): AtomicOperation;
    sum(key: KvKey, n: bigint): AtomicOperation;
    commit(): Promise<{ ok: true; versionstamp: string } | { ok: false }>;
  }
  interface KvListIterator<T> extends AsyncIterableIterator<KvEntry<T>> {
    readonly cursor: string;
  }
  interface Kv {
    get<T>(key: KvKey): Promise<KvEntryMaybe<T>>;
    getMany<T extends readonly unknown[]>(
      keys: readonly KvKey[],
    ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }>;
    set(key: KvKey, value: unknown, options?: { expireIn?: number }): Promise<{ ok: boolean }>;
    delete(key: KvKey): Promise<void>;
    list<T>(
      selector: { prefix: KvKey } | { start: KvKey; end: KvKey },
      options?: { limit?: number; cursor?: string; reverse?: boolean },
    ): KvListIterator<T>;
    atomic(): AtomicOperation;
    close(): void;
  }
  const env: { get(key: string): string | undefined };
  function openKv(path?: string): Promise<Kv>;
  function unrefTimer(id: number): void;
}
