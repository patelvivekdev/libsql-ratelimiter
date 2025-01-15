# libsql-ratelimiter

A flexible rate-limiting library built on top of libSQL, providing multiple algorithms (fixed window, sliding window, and token bucket) to control how frequently actions can be performed.

<div align="center">
<a href="https://www.npmjs.com/package/libsql-ratelimiter"><img src="https://img.shields.io/npm/v/libsql-ratelimiter"/><a>
<a href="https://www.npmjs.com/package/libsql-ratelimiter"><img src="https://img.shields.io/npm/dm/libsql-ratelimiter"/><a>
<a href="https://github.com/patelvivekdev/libsql-ratelimiter/actions/workflows/CI.yml"><img src="https://github.com/patelvivekdev/libsql-ratelimiter/actions/workflows/CI.yml/badge.svg"/><a>
</div>
<br>

## Installation

```bash
npm install libsql-ratelimiter
```

## Configuration

Environment variables can be used to set the configuration:

```env
LIBSQL_URL=
LIBSQL_AUTH_TOKEN=
```

## Basic Usage

```typescript
import { createRateLimiter } from 'libsql-ratelimiter';

async function example() {
  const rateLimiter = await createRateLimiter({
    url: 'file:./path/to/rate-limit.db', // process.env.LIBSQL_URL
    // ...other config like authToken LIBSQL_AUTH_TOKEN can be used
  });

  // Check if it's initialized
  console.log('Is initialized?', rateLimiter.isInitialized());

  // Limit requests using the fixed window algorithm
  const result = await rateLimiter.limit({
    key: 'someUser',
    limit: 5, // requests
    window: 60, // seconds
    algorithm: 'fixed', // 'fixed', 'sliding', or 'token'
  });
  console.log('Fixed window result:', result);

  // Close the client when done
  rateLimiter.close();
}
```

## API

### `createRateLimiter(config?)`

Creates and returns a new RateLimiter instance.

### `limit(options)`

Checks if a given request identified by `options.key` should be allowed under the specified algorithm. Returns a RateLimitResult object containing:

- `success`: whether the request is allowed
- `limit`: max capacity
- `remaining`: remaining limit
- `reset`: milliseconds until limit resets

### `isInitialized()`

Returns a boolean indicating if the underlying table is set up.

### `close()`

Closes the underlying client connection.
