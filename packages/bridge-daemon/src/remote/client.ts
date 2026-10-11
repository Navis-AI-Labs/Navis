import { hashCommandPayload } from '@navis/domain';
import { lstat, readFile } from 'node:fs/promises';
import { deviceCredentialSchema, type DeviceCredential } from '@navis/contracts';
import { remoteSchema } from '../runtime/request.js';
import { checkWindowsAccess } from '../security/private-files.js';

export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: string,
  ) {
    super(`Navis request failed (${String(status)}): ${code}`);
  }
}

/** Explicit private-file credentials support unattended local clients without copying keys into configuration. */
export async function readCredential(file: string): Promise<DeviceCredential> {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 8192 ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error('credential file must be a private regular file owned by the current user');
  if (process.platform === 'win32') checkWindowsAccess('check', file);
  return deviceCredentialSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export class NavisClient {
  readonly remote: string;
  constructor(
    remote: string,
    private readonly credentialFile: string,
    private readonly credentialFingerprint?: string,
  ) {
    this.remote = remoteSchema.parse(remote);
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<unknown> {
    const credential = await readCredential(this.credentialFile);
    if (
      this.credentialFingerprint !== undefined &&
      hashCommandPayload(credential) !== this.credentialFingerprint
    )
      throw new Error('credential changed; reconfigure the connection');
    const response = await fetch(`${this.remote}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${credential.key_id}.${credential.key_secret}`,
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body === null) throw new RemoteError(response.status, 'empty-response');
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > 16_777_216) throw new RemoteError(response.status, 'response-too-large');
      chunks.push(chunk);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (response.ok) throw new RemoteError(response.status, 'invalid-json');
      parsed = null;
    }
    if (!response.ok) {
      const code =
        typeof parsed === 'object' &&
        parsed !== null &&
        'code' in parsed &&
        typeof parsed.code === 'string'
          ? parsed.code
          : 'request-failed';
      const header = response.headers.get('retry-after');
      const seconds = header === null ? NaN : Number(header);
      const deadline =
        header === null
          ? NaN
          : Number.isFinite(seconds)
            ? Date.now() + Math.max(0, seconds) * 1000
            : Date.parse(header);
      const retryAfter = Number.isFinite(deadline)
        ? new Date(Math.min(Date.now() + 3_600_000, Math.max(Date.now(), deadline))).toISOString()
        : undefined;
      throw new RemoteError(response.status, code, retryAfter);
    }
    if (typeof parsed !== 'object' || parsed === null || !('data' in parsed))
      throw new RemoteError(response.status, 'invalid-envelope');
    return parsed.data;
  }
}
