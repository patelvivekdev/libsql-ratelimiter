import { createClient, type Client, LibsqlError } from '@libsql/client';

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

interface RateLimitConfig {
  url?: string;
  authToken?: string;
  tableName?: string;
}

type TimeUnit = 'milliseconds' | 'seconds' | 'minutes' | 'hours';

type Algorithm = 'fixed' | 'sliding' | 'tokenBucket';

interface RateLimitOptions {
  key: string;
  limit: number;
  window: number;
  timeUnit?: TimeUnit;
  algorithm?: Algorithm;
  capacity?: number;
  refillRate?: number;
  tokensToConsume?: number;
  prefix?: string;
}

const TIME_MULTIPLIERS = {
  milliseconds: 1 / 1000,
  seconds: 1,
  minutes: 60,
  hours: 3600,
} as const;

interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

class RateLimiter {
  private readonly client: Client;
  private readonly tableName: string;
  private initialized: boolean = false;

  constructor(config: RateLimitConfig = {}) {
    const url = config.url || process.env.LIBSQL_URL || 'file:./data.db';
    const authToken = config.authToken || process.env.LIBSQL_AUTH_TOKEN;

    if (!url) {
      throw new Error(
        'Database URL is required. Set LIBSQL_URL environment variable or pass it in config.',
      );
    }
    if (
      config.tableName &&
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.tableName)
    ) {
      throw new Error(
        'Invalid table name: must start with letter/underscore and contain only alphanumeric characters',
      );
    }

    this.client = createClient({ url, authToken });
    this.tableName = config.tableName || 'rate_limits';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          key TEXT PRIMARY KEY,
          count INTEGER,
          reset_at INTEGER,
          tokens INTEGER,
          last_refill INTEGER
        )
      `;
      await this.client.execute(sql);
      this.initialized = true;
    } catch (error) {
      if (error instanceof LibsqlError) {
        throw new Error(`Database error: ${error.message}`);
      }
      throw new Error(`Failed to initialize rate limiter: ${error}`);
    }
  }

  /**
   * Converts time to seconds based on specified unit
   * @throws {Error} If window value is invalid
   */
  private convertToSeconds(
    window: number,
    timeUnit: TimeUnit = 'seconds',
  ): number {
    if (typeof window !== 'number' || isNaN(window) || window <= 0) {
      throw new Error('Window must be a positive number');
    }

    const multiplier = TIME_MULTIPLIERS[timeUnit];
    return window * multiplier;
  }

  private async applyFixedWindow(
    key: string,
    limit: number,
    windowInSeconds: number,
  ): Promise<RateLimitResult> {
    if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
      throw new RateLimitError(
        'Invalid limit value. Must be a positive number.',
      );
    }
    const now = Date.now();
    const resetAt = now + windowInSeconds * 1000;
    let count: number;
    let currentResetAt: number;

    const transaction = await this.client.transaction('write');
    try {
      const updateSql = `
        UPDATE ${this.tableName}
        SET count = CASE
          WHEN reset_at <= ? THEN 1
          ELSE count + 1
        END,
        reset_at = CASE
          WHEN reset_at <= ? THEN ?
          ELSE reset_at
        END
        WHERE key = ?
        RETURNING count, reset_at
      `;
      const updateArgs = [now, now, resetAt, key];

      const updateResult = await transaction.execute({
        sql: updateSql,
        args: updateArgs,
      });

      if (updateResult.rows.length === 0) {
        const insertSql = `
          INSERT INTO ${this.tableName} (key, count, reset_at)
          VALUES (?, 1, ?)
          RETURNING count, reset_at
        `;
        const insertArgs = [key, resetAt];

        const insertResult = await transaction.execute({
          sql: insertSql,
          args: insertArgs,
        });

        const row = insertResult.rows[0];
        if (!row) {
          throw new RateLimitError('Failed to insert rate limit record');
        }
        count = Number(row.count);
        currentResetAt = Number(row.reset_at);
      } else {
        const row = updateResult.rows[0];
        if (!row) {
          throw new RateLimitError('Failed to update rate limit record');
        }
        count = Number(row.count);
        currentResetAt = Number(row.reset_at);
      }

      await transaction.commit();
    } catch (error: any) {
      await transaction.rollback();
      throw new Error(`Failed to check rate limit: ${error.message}`);
    } finally {
      transaction.close();
    }

    const remaining = Math.max(0, limit - count);
    const reset = Math.max(0, currentResetAt - now);

    return {
      success: count <= limit,
      limit,
      remaining,
      reset,
    };
  }

  private async applySlidingWindow(
    key: string,
    limit: number,
    windowInSeconds: number,
  ): Promise<RateLimitResult> {
    if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
      throw new RateLimitError(
        'Invalid limit value. Must be a positive number.',
      );
    }
    const now = Date.now();
    const windowStart = now - windowInSeconds * 1000;
    let count: number;

    const transaction = await this.client.transaction('write');
    try {
      const selectSql = `
        SELECT count
        FROM ${this.tableName}
        WHERE key = ? AND reset_at > ?
      `;
      const selectArgs = [key, windowStart];

      const selectResult = await transaction.execute({
        sql: selectSql,
        args: selectArgs,
      });

      if (selectResult.rows.length === 0) {
        const insertSql = `
          INSERT INTO ${this.tableName} (key, count, reset_at)
          VALUES (?, 1, ?)
          RETURNING count
        `;
        const insertArgs = [key, now + windowInSeconds * 1000];

        const insertResult = await transaction.execute({
          sql: insertSql,
          args: insertArgs,
        });

        const row = insertResult.rows[0];
        if (!row) {
          throw new RateLimitError('Failed to insert rate limit record');
        }
        count = Number(row.count);
      } else {
        const row = selectResult.rows[0];
        if (!row) {
          throw new RateLimitError('Failed to select rate limit record');
        }
        count = Number(row.count) + 1;

        const updateSql = `
          UPDATE ${this.tableName}
          SET count = ?
          WHERE key = ?
        `;
        const updateArgs = [count, key];

        await transaction.execute({
          sql: updateSql,
          args: updateArgs,
        });
      }

      await transaction.commit();
    } catch (error: any) {
      await transaction.rollback();
      throw new Error(`Failed to check rate limit: ${error.message}`);
    } finally {
      transaction.close();
    }

    const remaining = Math.max(0, limit - count);
    const reset = Math.max(0, windowInSeconds * 1000 - (now - windowStart));

    return {
      success: count <= limit,
      limit,
      remaining,
      reset,
    };
  }

  private async applyTokenBucket(
    key: string,
    capacity: number,
    refillRate: number,
    tokensToConsume: number,
  ): Promise<RateLimitResult> {
    if (typeof capacity !== 'number' || capacity <= 0) {
      throw new RateLimitError(
        'Invalid capacity value. Must be a positive number.',
      );
    }
    if (typeof refillRate !== 'number' || refillRate <= 0) {
      throw new RateLimitError(
        'Invalid refillRate value. Must be a positive number.',
      );
    }
    if (typeof tokensToConsume !== 'number' || tokensToConsume <= 0) {
      throw new RateLimitError(
        'Invalid tokens value. Must be a positive number.',
      );
    }

    const now = Date.now();
    let currentTokens: number;
    let lastRefill: number;

    const transaction = await this.client.transaction('write');
    try {
      const selectSql = `
        SELECT tokens, last_refill
        FROM ${this.tableName}
        WHERE key = ?
      `;
      const selectArgs = [key];

      const selectResult = await transaction.execute({
        sql: selectSql,
        args: selectArgs,
      });

      if (selectResult.rows.length === 0) {
        currentTokens = capacity - tokensToConsume;
        lastRefill = now;

        const insertSql = `
          INSERT INTO ${this.tableName} (key, tokens, last_refill)
          VALUES (?, ?, ?)
        `;
        const insertArgs = [key, currentTokens, lastRefill];

        await transaction.execute({
          sql: insertSql,
          args: insertArgs,
        });
      } else {
        const row = selectResult.rows[0];
        if (!row) {
          throw new RateLimitError('Failed to select token bucket record');
        }
        currentTokens = Number(row.tokens);
        lastRefill = Number(row.last_refill);

        const elapsedTime = now - lastRefill;
        const tokensToAdd = Math.floor((elapsedTime / 1000) * refillRate);
        currentTokens = Math.min(capacity, currentTokens + tokensToAdd);
        lastRefill = now;

        if (currentTokens < tokensToConsume) {
          throw new RateLimitError('Not enough tokens available');
        }

        currentTokens -= tokensToConsume;

        const updateSql = `
          UPDATE ${this.tableName}
          SET tokens = ?, last_refill = ?
          WHERE key = ?
        `;
        const updateArgs = [currentTokens, lastRefill, key];

        await transaction.execute({
          sql: updateSql,
          args: updateArgs,
        });
      }

      await transaction.commit();
    } catch (error: any) {
      await transaction.rollback();
      throw new Error(`Failed to apply token bucket: ${error.message}`);
    } finally {
      transaction.close();
    }

    return {
      success: true,
      remaining: currentTokens,
      limit: capacity,
      reset: Math.ceil(((tokensToConsume - currentTokens) / refillRate) * 1000),
    };
  }

  async limit({
    key,
    limit,
    window,
    timeUnit = 'seconds',
    algorithm = 'fixed',
    capacity,
    refillRate,
    tokensToConsume,
    prefix,
  }: RateLimitOptions): Promise<RateLimitResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const windowInSeconds = this.convertToSeconds(window, timeUnit);
    const effectiveKey = prefix ? prefix + ':' + key : key;

    if (algorithm === 'tokenBucket') {
      if (
        capacity === undefined ||
        refillRate === undefined ||
        tokensToConsume === undefined
      ) {
        throw new RateLimitError(
          'Token bucket algorithm requires capacity, refillRate, and tokensToConsume',
        );
      }
      return this.applyTokenBucket(
        effectiveKey,
        capacity,
        refillRate,
        tokensToConsume,
      );
    } else if (algorithm === 'sliding') {
      return this.applySlidingWindow(effectiveKey, limit, windowInSeconds);
    }
    return this.applyFixedWindow(effectiveKey, limit, windowInSeconds);
  }

  close() {
    this.client.close();
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export async function createRateLimiter(
  config: RateLimitConfig = {},
): Promise<RateLimiter> {
  const client = new RateLimiter(config);
  await client.initialize();
  return client;
}

export { RateLimiter, LibsqlError };
export type { RateLimitConfig, RateLimitOptions, RateLimitResult };
