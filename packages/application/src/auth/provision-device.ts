import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { uuidv7 } from '@navis/domain';
import {
  deviceCredentialSchema,
  deviceKeyVerifierFromSecret,
  type DeviceCredential,
} from '@navis/contracts';
import type { ProjectWorkspace } from '../ports/project-workspace.js';

/** Privileged local operation; no network route exposes this method. */
export function provisionDevice(
  workspace: ProjectWorkspace,
  now: () => string,
  name: string,
  kind: 'human' | 'agent',
): Promise<DeviceCredential> {
  const principal = {
    id: uuidv7(),
    name: z.string().trim().min(1).max(256).parse(name),
    kind: z.enum(['human', 'agent']).parse(kind),
  };
  const at = now();
  return workspace.transaction(`principal:${principal.id}`, async (tx) => {
    await tx.putPrincipal(principal, at);
    const device = await tx.devices.registerDevice({
      participantId: principal.id,
      name: principal.name,
      createdAt: at,
    });
    const keyId = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    await tx.devices.createKey({
      key_id: keyId,
      device_id: device.id,
      verifier: deviceKeyVerifierFromSecret(secret),
      algorithm: 'sha256',
      revoked_at: null,
      issued_at: at,
    });
    await tx.audit('principal.provisioned', principal.id, device.id, at);
    return deviceCredentialSchema.parse({
      participant_id: principal.id,
      participant_type: kind,
      device_id: device.id,
      key_id: keyId,
      key_secret: secret,
      issued_at: at,
    });
  });
}
