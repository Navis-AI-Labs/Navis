import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEVICE_TOKEN_POLL_INTERVAL_SECONDS,
  UnsupportedDeviceAuthContractVersionError,
  deviceAuthContractSchemaVersion,
  deviceAuthDenialTokens,
  deviceKeyVerifierFromSecret,
  deviceKeyVerifierSchema,
  deviceRegistrationRequestSchema,
  deviceRevocationRequestSchema,
  deviceTokenRequestSchema,
  parseDeviceAuthRequest,
} from '../src/device-auth.js';

const SECRET = 'a'.repeat(48);

describe('deviceKeyVerifierFromSecret', () => {
  it('computes the sha256 hex verifier of a key secret', () => {
    expect(deviceKeyVerifierFromSecret(SECRET)).toBe(
      createHash('sha256').update(SECRET, 'utf8').digest('hex'),
    );
  });

  it('is 64 lowercase hex characters', () => {
    expect(deviceKeyVerifierFromSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the secret', () => {
    expect(deviceKeyVerifierFromSecret(SECRET)).not.toContain(SECRET);
  });
});

describe('deviceKeyVerifierSchema', () => {
  it('accepts a well-formed verifier', () => {
    const parsed = deviceKeyVerifierSchema.safeParse({
      key_id: '01924b61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
      verifier: deviceKeyVerifierFromSecret(SECRET),
      algorithm: 'sha256',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an undeclared field', () => {
    const parsed = deviceKeyVerifierSchema.safeParse({
      key_id: '01924b61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
      verifier: deviceKeyVerifierFromSecret(SECRET),
      algorithm: 'sha256',
      leak: SECRET,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('deviceTokenRequestSchema', () => {
  it('accepts the RFC 8628 device-code grant', () => {
    const parsed = deviceTokenRequestSchema.safeParse({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'x'.repeat(32),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects any other grant type', () => {
    const parsed = deviceTokenRequestSchema.safeParse({
      grant_type: 'authorization_code',
      device_code: 'x'.repeat(32),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('deviceRegistrationRequestSchema', () => {
  it('accepts a bounded device name', () => {
    const parsed = deviceRegistrationRequestSchema.safeParse({ name: 'macbook-pro-14' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const parsed = deviceRegistrationRequestSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('deviceRevocationRequestSchema', () => {
  it('accepts revocation with or without a reason', () => {
    expect(
      deviceRevocationRequestSchema.safeParse({
        device_id: '01924b61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
      }).success,
    ).toBe(true);
    expect(
      deviceRevocationRequestSchema.safeParse({
        device_id: '01924b61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
        reason: 'laptop replaced',
      }).success,
    ).toBe(true);
  });

  it('rejects an undeclared field', () => {
    const parsed = deviceRevocationRequestSchema.safeParse({
      device_id: '01924b61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
      grace_period_seconds: 300,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('deviceAuthDenialTokens', () => {
  it('exposes revocation as a denial token', () => {
    expect(deviceAuthDenialTokens.device_revoked).toBe('device-auth/device-revoked');
  });

  it('has a stable contract version', () => {
    expect(deviceAuthContractSchemaVersion).toBe(1);
  });
});

describe('polling constants', () => {
  it('declares a bounded poll interval', () => {
    expect(DEVICE_TOKEN_POLL_INTERVAL_SECONDS).toBeGreaterThanOrEqual(1);
    expect(DEVICE_TOKEN_POLL_INTERVAL_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe('parseDeviceAuthRequest version precheck', () => {
  it('refuses an unsupported contract version before any credential is inspected', () => {
    expect(() =>
      parseDeviceAuthRequest({ contract_version: 99, device_code: 'x'.repeat(32) }),
    ).toThrow(UnsupportedDeviceAuthContractVersionError);
  });

  it('passes a supported contract version through untouched', () => {
    const input = { contract_version: 1, note: 'shape only' };
    expect(parseDeviceAuthRequest(input)).toBe(input);
  });

  it('does not refuse a request whose version field is malformed', () => {
    // A malformed version falls through to the schema error, not the version refusal.
    expect(parseDeviceAuthRequest({ contract_version: 'nope' })).toEqual({
      contract_version: 'nope',
    });
  });
});
