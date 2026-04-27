import { retry, RetryError, type RetryClassifier, type RetryPolicy } from './retry.js';

export type WebappFailure =
  | { kind: 'network'; err: unknown }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'app'; error: string };

export class WebappError extends Error {
  readonly action: string;
  readonly ssId: string | undefined;
  readonly attempts: number;
  readonly lastStatus: number | undefined;
  readonly lastBody: string | undefined;
  readonly appError: string | undefined;
  override cause: unknown;

  constructor(opts: {
    action: string;
    ssId?: string;
    attempts: number;
    failure: WebappFailure;
    cause?: unknown;
  }) {
    const { action, ssId, attempts, failure } = opts;
    const ctxParts = [
      `action=${action}`,
      ssId ? `ssId=${ssId}` : '',
      `attempts=${attempts}`,
    ].filter(Boolean);
    let detail: string;
    let lastStatus: number | undefined;
    let lastBody: string | undefined;
    let appError: string | undefined;
    switch (failure.kind) {
      case 'network':
        detail = `network error: ${failure.err instanceof Error ? failure.err.message : String(failure.err)}`;
        break;
      case 'http':
        lastStatus = failure.status;
        lastBody = truncate(failure.body, 500);
        detail = `HTTP ${failure.status}: ${lastBody || '(empty body)'}`;
        break;
      case 'app':
        appError = failure.error;
        detail = `app error: ${failure.error}`;
        break;
    }
    super(`webapp ${detail} [${ctxParts.join(' ')}]`);
    this.name = 'WebappError';
    this.action = action;
    this.ssId = ssId;
    this.attempts = attempts;
    this.lastStatus = lastStatus;
    this.lastBody = lastBody;
    this.appError = appError;
    this.cause = opts.cause;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (${s.length - n} more bytes)`;
}

export function classifyWebappError(f: WebappFailure): 'retry' | 'retry-after-quota' | 'fatal' {
  switch (f.kind) {
    case 'network':
      return 'retry';
    case 'http':
      if (f.status === 429) return 'retry';
      if (f.status >= 500) return 'retry';
      return 'fatal';
    case 'app':
      if (f.error === 'Quota exceeded') return 'retry-after-quota';
      return 'fatal';
  }
}

interface AppScriptResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  action?: string;
  effectiveUser?: string;
}

export interface WebappClientDeps {
  url: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  policy?: RetryPolicy;
  timeoutMs?: number;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8000,
  jitter: 0.5,
  quotaDelayMs: 60_000,
};

export class WebappClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly policy: RetryPolicy;
  private readonly timeoutMs: number;

  constructor(deps: WebappClientDeps) {
    if (!deps.url) throw new Error('WebappClient: url is required');
    this.url = deps.url;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.policy = deps.policy ?? DEFAULT_POLICY;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
  }

  async do<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
    const ssId = typeof payload['ssId'] === 'string' ? (payload['ssId'] as string) : undefined;
    const body = JSON.stringify({ action, ...payload });

    const classify: RetryClassifier = (err) => {
      if (err instanceof FailureCarrier) return classifyWebappError(err.failure);
      return 'fatal';
    };

    try {
      return await retry<T>(
        async () => this.attempt<T>(body),
        { policy: this.policy, classify, sleep: this.sleep },
      );
    } catch (e) {
      if (e instanceof RetryError && e.cause instanceof FailureCarrier) {
        throw new WebappError({
          action,
          ssId,
          attempts: e.attempts,
          failure: e.cause.failure,
          cause: e.cause,
        });
      }
      throw e;
    }
  }

  private async attempt<T>(body: string): Promise<T> {
    let resp: Awaited<ReturnType<typeof fetch>>;
    try {
      resp = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      throw new FailureCarrier({ kind: 'network', err });
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new FailureCarrier({ kind: 'http', status: resp.status, body: text });
    }
    let parsed: AppScriptResponse;
    try {
      parsed = JSON.parse(text) as AppScriptResponse;
    } catch {
      throw new FailureCarrier({
        kind: 'http',
        status: resp.status,
        body: `non-JSON response: ${text.slice(0, 200)}`,
      });
    }
    if (!parsed.success) {
      throw new FailureCarrier({ kind: 'app', error: parsed.error ?? 'unknown app error' });
    }
    return parsed.result as T;
  }
}

class FailureCarrier extends Error {
  readonly failure: WebappFailure;
  constructor(failure: WebappFailure) {
    super(failureMessage(failure));
    this.failure = failure;
  }
}

function failureMessage(f: WebappFailure): string {
  switch (f.kind) {
    case 'network':
      return `network: ${f.err instanceof Error ? f.err.message : String(f.err)}`;
    case 'http':
      return `HTTP ${f.status}`;
    case 'app':
      return f.error;
  }
}
