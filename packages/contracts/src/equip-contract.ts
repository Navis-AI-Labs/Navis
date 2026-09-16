import { z } from 'zod';

import {
  instantWireSchema,
  labelWireSchema,
  stateVersionWireSchema,
  textWireSchema,
  uuidRefSchema,
} from './wire-primitives.js';

/**
 * The public shape of an issued Equip. The kernel is the sole grant
 * authority; this contract only publishes what the server handed out.
 *
 * IMPORTANT (normative): `allowed_actions` is descriptive data only. It
 * records what the server permitted at the moment of issuance so an
 * adapter can plan; it never grants anything, and no consumer may treat
 * its presence as authorization. Authorization lives with the kernel's
 * guards, never with this list.
 *
 * Re-declared here under the contracts/D1 dual-authority decision: the
 * contract never imports the server's internal types, and golden fixtures
 * pin the correspondence so an internal refactor cannot silently move the
 * public shape.
 */

/** Causal snapshot: participant id -> count of that participant's observed events. */
export const equipCausalSnapshotSchema = z.record(
  uuidRefSchema,
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
);

const equipShape = {
  id: uuidRefSchema,
  state_version: stateVersionWireSchema,
  work_id: uuidRefSchema.optional(),
  participant_id: uuidRefSchema.optional(),
  causal_snapshot: equipCausalSnapshotSchema,
  verified_facts: z.array(textWireSchema).max(100),
  active_assets: z.array(uuidRefSchema).max(100),
  active_holds: z.array(uuidRefSchema).max(100),
  boundary: textWireSchema.optional(),
  acceptance_criteria: z.array(textWireSchema).max(100).optional(),
  allowed_actions: z.array(labelWireSchema).max(100).optional(),
  issued_at: instantWireSchema,
  status: z.literal('active'),
} as const;

/** Producer-strict issued-equip schema (undeclared fields reject). */
export const equipContractStrictSchema = z.strictObject(equipShape).meta({
  description:
    'Issued Equip as handed to a caller (producer-strict). allowed_actions is descriptive-only and never authorizing.',
  id: 'EquipContractStrict',
});

/** Consumer-tolerant issued-equip schema (undeclared fields are dropped). */
export const equipContractSchema = z.object(equipShape).meta({
  description:
    'Issued Equip as handed to a caller (consumer-tolerant). allowed_actions is descriptive-only and never authorizing.',
  id: 'EquipContract',
});

export type EquipContract = z.infer<typeof equipContractSchema>;

/** Producer path: the serving edge serializes an equip for wire output. */
export function encodeEquipContract(input: unknown): EquipContract {
  return equipContractStrictSchema.parse(input);
}

/** Consumer path: adapters and bridges validate a received issued equip. */
export function parseEquipContract(input: unknown): EquipContract {
  return equipContractSchema.parse(input);
}
