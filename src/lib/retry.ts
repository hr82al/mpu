export type RetryDecision = 'retry' | 'retry-after-quota' | 'fatal';

export type RetryClassifier = (err: unknown, attempt: number) => RetryDecision;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  quotaDelayMs: number;
}

export interface RetryDeps<T> {
  policy: RetryPolicy;
  classify: RetryClassifier;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown; reason: RetryDecision }) => void;
  _phantom?: T;
}

export class RetryError extends Error {
  attempts: number;
  override cause: unknown;
  constructor(cause: unknown, attempts: number) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(causeMsg);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export async function retry<T>(
  fn: () => Promise<T>,
  deps: RetryDeps<T>,
): Promise<T> {
  const { policy, classify } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const decision = classify(err, attempt);
      if (decision === 'fatal' || attempt === policy.maxAttempts) {
        throw new RetryError(err, attempt);
      }
      const delayMs =
        decision === 'retry-after-quota'
          ? policy.quotaDelayMs
          : computeBackoff(policy, attempt, random);
      deps.onRetry?.({ attempt, delayMs, err, reason: decision });
      await sleep(delayMs);
    }
  }
  throw new RetryError(lastErr, policy.maxAttempts);
}

function computeBackoff(policy: RetryPolicy, attempt: number, random: () => number): number {
  const exp = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  if (policy.jitter <= 0) return capped;
  const jitterAmount = capped * policy.jitter * random();
  return Math.min(policy.maxDelayMs, Math.round(capped + jitterAmount));
}
