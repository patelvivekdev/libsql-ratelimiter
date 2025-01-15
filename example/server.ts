import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRateLimiter, RateLimitResult } from '../src/index';
import { config } from 'dotenv';

config({ path: '.env' });

// Configuration (example)
const rateLimitConfig = {
  minute: {
    limit: 5,
    window: 60,
  },
  day: {
    limit: 10,
    window: 86400,
  },
};

// Add rate limit middleware
async function checkRateLimit(c: any, next: any) {
  const rateLimiter = await createRateLimiter({
    url: process.env.LIBSQL_URL!,
    authToken: process.env.LIBSQL_AUTH_TOKEN!,
  });

  const identifier =
    c.req.header['x-real-ip'] || c.req.header['x-forwarded-for'] || 'test'; // Consider more robust IP detection

  // Check minute limit
  const minuteLimit: RateLimitResult = await rateLimiter.limit({
    key: `ratelimit:ip:${identifier}:minute`, // Added prefix
    limit: rateLimitConfig.minute.limit,
    window: rateLimitConfig.minute.window,
  });

  // Set minute limit headers
  c.header('X-RateLimit-Minute-Limit', minuteLimit.limit.toString());
  c.header('X-RateLimit-Minute-Remaining', minuteLimit.remaining.toString());
  c.header(
    'X-RateLimit-Minute-Reset',
    new Date(Date.now() + minuteLimit.reset).toUTCString(),
  );

  if (!minuteLimit.success) {
    const resetTime = new Date(Date.now() + minuteLimit.reset);
    return c.json(
      {
        error: 'Minute rate limit exceeded',
        limit: minuteLimit.limit, // Added limit to response
        resetTime,
        remaining: minuteLimit.remaining,
      },
      429,
    );
  }

  // Check daily limit
  const dayLimit: RateLimitResult = await rateLimiter.limit({
    key: `ratelimit:ip:${identifier}:day`, // Added prefix
    limit: rateLimitConfig.day.limit,
    window: rateLimitConfig.day.window,
  });

  // Set daily limit headers
  c.header('X-RateLimit-Day-Limit', dayLimit.limit.toString());
  c.header('X-RateLimit-Day-Remaining', dayLimit.remaining.toString());
  c.header(
    'X-RateLimit-Day-Reset',
    new Date(Date.now() + dayLimit.reset).toUTCString(),
  );

  if (!dayLimit.success) {
    const resetTime = new Date(Date.now() + dayLimit.reset);
    return c.json(
      {
        error: 'Daily rate limit exceeded',
        limit: dayLimit.limit, // Added limit to response
        resetTime,
        remaining: dayLimit.remaining,
      },
      429,
    );
  }

  return await next();
}

const app = new Hono();
app.use('/api/*', checkRateLimit);

app.get('/', async (c) => {
  return c.text('Hono AI is running!');
});

// Update rate-limit test endpoint
app.get('/api/', async (c) => {
  return c.json({ message: 'API Request allowed', timestamp: new Date() });
});

serve({ fetch: app.fetch, port: 8080 });
