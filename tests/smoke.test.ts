import { describe, it, expect } from '@jest/globals';

describe('smoke', () => {
  it('Проверяет: Jest + ts-jest + ESM-пайплайн работает', () => {
    expect(1 + 1).toBe(2);
  });
});
