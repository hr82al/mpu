import { describe, it, expect, jest } from '@jest/globals';
import { retry, type RetryClassifier, type RetryPolicy } from '../src/lib/retry.js';

function makePolicy(over: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 8000,
    jitter: 0,
    quotaDelayMs: 60_000,
    ...over,
  };
}

const retryAll: RetryClassifier = () => 'retry';
const fatalAll: RetryClassifier = () => 'fatal';

describe('retry', () => {
  it('Проверяет: возвращает результат при успехе с первого раза', async () => {
    const fn = jest.fn(async () => 42);
    const sleep = jest.fn(async () => {});
    const result = await retry(fn as () => Promise<number>, {
      policy: makePolicy(),
      classify: retryAll,
      sleep,
    });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Проверяет: ретраит transient-ошибку и возвращает успех', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 3) throw new Error('boom');
      return 'ok';
    };
    const sleep = jest.fn(async () => {});
    const result = await retry(fn, {
      policy: makePolicy(),
      classify: retryAll,
      sleep,
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: fatal-ошибка не ретраится', async () => {
    const fn = jest.fn(async () => {
      throw new Error('nope');
    });
    const sleep = jest.fn(async () => {});
    await expect(
      retry(fn as () => Promise<unknown>, {
        policy: makePolicy(),
        classify: fatalAll,
        sleep,
      }),
    ).rejects.toThrow(/nope/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Проверяет: исчерпание попыток выкидывает последнюю ошибку с количеством attempts', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    };
    const sleep = jest.fn(async () => {});
    await expect(
      retry(fn, {
        policy: makePolicy({ maxAttempts: 3 }),
        classify: retryAll,
        sleep,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/fail-3/),
      attempts: 3,
    });
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: экспоненциальный backoff с base=100, ограниченный maxDelay', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('x');
    };
    await expect(
      retry(fn, {
        policy: makePolicy({ maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 500, jitter: 0 }),
        classify: retryAll,
        sleep,
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400, 500, 500]);
  });

  it('Проверяет: классификация retry-after-quota использует quotaDelayMs', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('Quota exceeded');
      return 'ok';
    };
    const classify: RetryClassifier = (e) =>
      (e as Error).message.includes('Quota') ? 'retry-after-quota' : 'fatal';
    const result = await retry(fn, {
      policy: makePolicy({ quotaDelayMs: 60_000 }),
      classify,
      sleep,
    });
    expect(result).toBe('ok');
    expect(delays).toEqual([60_000]);
  });

  it('Проверяет: jitter добавляет случайное смещение [0, base*2^n*jitter]', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('x');
    };
    await expect(
      retry(fn, {
        policy: makePolicy({ maxAttempts: 3, baseDelayMs: 100, jitter: 0.5 }),
        classify: retryAll,
        sleep,
        random: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([150, 300]);
  });
});
