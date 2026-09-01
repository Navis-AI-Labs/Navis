import { describe, expect, it } from 'vitest';

import {
  createConnection,
  POOL_IDLE_TIMEOUT,
  POOL_MAX,
  POOL_MAX_LIFETIME,
} from '../src/persistence/postgres/connection.js';

describe('connection factory', () => {
  it('exposes production-baseline pool tuning as named constants', () => {
    expect(POOL_MAX).toBe(50);
    expect(POOL_IDLE_TIMEOUT).toBe(20);
    expect(POOL_MAX_LIFETIME).toBe(5 * 60);
  });

  it('applies the pool options to the created connection (engine-neutral URL)', async () => {
    const sql = createConnection('postgres://user:pass@localhost:5432/navis');
    expect(sql.options.max).toBe(50);
    expect(sql.options.idle_timeout).toBe(20);
    expect(sql.options.max_lifetime).toBe(300);
    await sql.end({ timeout: 0 });
  });
});
