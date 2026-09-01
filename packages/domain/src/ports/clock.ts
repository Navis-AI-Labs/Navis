/**
 * Time port: injectable clock for kernel stamps and tests. Zero driver
 * types — infrastructure or tests supply the implementation; the domain
 * never reads the system clock directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
