import { createRateLimiter, RateLimiter, type RateLimitOptions } from './index';
import { describe, it, expect } from 'vitest';

import fs from 'fs';
import path from 'path';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeAll(async () => {
    const TEST_DB_PATH = path.join(__dirname, 'test.db');

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    rateLimiter = await createRateLimiter({
      url: `file:${TEST_DB_PATH}`,
    });
  });

  afterAll(() => {
    rateLimiter.close();
  });

  it('should initialize the rate limiter', async () => {
    await rateLimiter.limit({
      key: 'initialize',
      limit: 1,
      window: 60,
    } as RateLimitOptions);
    expect(rateLimiter.isInitialized()).toBe(true);
  });

  describe('Fixed Window Algorithm', () => {
    it('should allow requests within limit', async () => {
      await rateLimiter.limit({
        key: 'fixed-test',
        limit: 10,
        window: 2,
        timeUnit: 'seconds',
        algorithm: 'fixed',
      });

      await rateLimiter.limit({
        key: 'fixed-test',
        limit: 10,
        window: 2,
        timeUnit: 'seconds',
        algorithm: 'fixed',
      });

      const result = await rateLimiter.limit({
        key: 'fixed-test',
        limit: 10,
        window: 2,
        timeUnit: 'seconds',
        algorithm: 'fixed',
      });

      expect(result.success).toBe(true);
      expect(result.remaining).toBe(7);
    });

    it('should block requests exceeding limit', async () => {
      // First request
      await rateLimiter.limit({
        key: 'fixed-exceed-test',
        limit: 2,
        window: 60,
        algorithm: 'fixed',
      });

      await rateLimiter.limit({
        key: 'fixed-exceed-test',
        limit: 2,
        window: 60,
        algorithm: 'fixed',
      });

      // Second request should be blocked
      const result = await rateLimiter.limit({
        key: 'fixed-exceed-test',
        limit: 2,
        window: 60,
        algorithm: 'fixed',
      });

      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Sliding Window Algorithm', () => {
    it('should allow requests within limit', async () => {
      const result = await rateLimiter.limit({
        key: 'sliding-test',
        limit: 5,
        window: 60,
        algorithm: 'sliding',
      });

      expect(result.success).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('should block requests exceeding limit', async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimiter.limit({
          key: 'sliding-exceed-test',
          limit: 5,
          window: 60,
          algorithm: 'sliding',
        });
      }

      const result = await rateLimiter.limit({
        key: 'sliding-exceed-test',
        limit: 5,
        window: 60,
        algorithm: 'sliding',
      });

      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Token Bucket Algorithm', () => {
    it('should allow requests when tokens are available', async () => {
      const result = await rateLimiter.limit({
        key: 'token-test',
        limit: 10,
        window: 60,
        algorithm: 'tokenBucket',
        capacity: 10,
        refillRate: 1,
        tokensToConsume: 3,
      } as RateLimitOptions);

      expect(result.success).toBe(true);
      expect(result.remaining).toBe(7);
    });

    it('should block requests when tokens are insufficient', async () => {
      await rateLimiter.limit({
        key: 'token-insufficient-test',
        limit: 10,
        window: 60,
        algorithm: 'tokenBucket',
        capacity: 10,
        refillRate: 1,
        tokensToConsume: 10,
      } as RateLimitOptions);

      await expect(
        rateLimiter.limit({
          key: 'token-insufficient-test',
          limit: 10,
          window: 60,
          algorithm: 'tokenBucket',
          capacity: 10,
          refillRate: 1,
          tokensToConsume: 1,
        } as RateLimitOptions),
      ).rejects.toThrow('Not enough tokens available');
    });
  });

  describe('Real-World Scenarios', () => {
    it('should rate limit a user making multiple API calls in short time', async () => {
      const userKey = 'api-user';
      const limitOptions = {
        key: userKey,
        limit: 3,
        window: 10,
        algorithm: 'fixed',
      } as RateLimitOptions;
      for (let i = 0; i < 3; i++) {
        const result = await rateLimiter.limit(limitOptions);
        expect(result.success).toBe(true);
      }
      const resultExceed = await rateLimiter.limit(limitOptions);
      expect(resultExceed.success).toBe(false);
    });

    it('should handle multiple keys (e.g., different users) separately', async () => {
      const firstUserResult = await rateLimiter.limit({
        key: 'firstUser',
        limit: 2,
        window: 10,
        algorithm: 'sliding',
      });
      const secondUserResult = await rateLimiter.limit({
        key: 'secondUser',
        limit: 2,
        window: 10,
        algorithm: 'sliding',
      });
      expect(firstUserResult.success).toBe(true);
      expect(secondUserResult.success).toBe(true);
    });
  });
});
