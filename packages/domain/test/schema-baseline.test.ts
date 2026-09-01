import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  acceptanceResultSchema,
  acceptanceSchema,
  acceptanceTargetTypeSchema,
  assetContentStorageSchema,
  assetSchema,
  checkpointSchema,
  deliveryConfirmationStatusSchema,
  deliverySchema,
  deliveryTargetTypeSchema,
  equipSchema,
  equipStatusSchema,
  fowlerQuadrantSchema,
  holdSchema,
  holdSeveritySchema,
  interventionModeSchema,
  participantSchema,
  participantTypeSchema,
  projectSchema,
  taskspaceSchema,
  workRunSchema,
  workSchema,
} from '../src/schema/index.js';
import { eventEnvelopeSchema } from '../src/ports/event-store.js';
import { uuidv7 } from '../src/schema/ids.js';

/**
 * Baseline guard: field sets and enum sets must equal the accepted
 * research baseline. This test FAILS on any local invention — renamed
 * field, extra field, missing enum value, extra enum value.
 */

const NOW = '2026-08-29T12:00:00.000Z';

function fieldNames(shape: object): string[] {
  return Object.keys(shape).sort();
}

const envelopeBase = {
  event_id: uuidv7(),
  project_id: uuidv7(),
  seq: 1,
  aggregate_type: 'project',
  aggregate_id: uuidv7(),
  aggregate_revision: 1,
  event_type: 'project.created',
  event_schema_version: 1,
  occurred_at: NOW,
  recorded_at: NOW,
  payload: {},
  metadata: {},
  privacy_class: 'evidence',
  state_version: 1,
};

describe('baseline guard: field sets equal the accepted baseline', () => {
  it('Project fields', () => {
    expect(fieldNames(projectSchema.shape)).toEqual([
      'acceptance_criteria',
      'boundary',
      'created_at',
      'current_state_version',
      'deleted_at',
      'id',
      'purpose',
      'status',
      'title',
      'updated_at',
      'updated_by',
    ]);
  });

  it('Work fields', () => {
    expect(fieldNames(workSchema.shape)).toEqual([
      'acceptance_criteria',
      'created_at',
      'deleted_at',
      'depends_on',
      'direction',
      'id',
      'project_id',
      'status',
      'title',
      'updated_at',
      'updated_by',
    ]);
  });

  it('TaskSpace fields', () => {
    expect(fieldNames(taskspaceSchema.shape)).toEqual([
      'created_at',
      'deleted_at',
      'id',
      'updated_at',
      'updated_by',
      'work_id',
    ]);
  });

  it('Asset fields', () => {
    expect(fieldNames(assetSchema.shape)).toEqual([
      'content',
      'created_at',
      'deleted_at',
      'id',
      'kind',
      'lifecycle',
      'project_id',
      'provenance',
      'scope',
      'updated_at',
      'updated_by',
      'valid_from',
      'valid_to',
    ]);
  });

  it('Acceptance fields', () => {
    expect(fieldNames(acceptanceSchema.shape)).toEqual([
      'actor',
      'created_at',
      'criteria_snapshot',
      'deleted_at',
      'evidence_refs',
      'id',
      'rationale',
      'result',
      'target_ref',
      'target_type',
      'updated_at',
      'updated_by',
    ]);
  });

  it('Delivery fields', () => {
    expect(fieldNames(deliverySchema.shape)).toEqual([
      'asset_id',
      'attempt_no',
      'confirmation_status',
      'confirmed_at',
      'confirmed_by',
      'created_at',
      'deleted_at',
      'dispatched_at',
      'feedback',
      'id',
      'target_ref',
      'target_type',
      'updated_at',
      'updated_by',
      'version',
    ]);
  });

  it('WorkRun fields', () => {
    expect(fieldNames(workRunSchema.shape)).toEqual([
      'attempt',
      'checkpoint_id',
      'created_at',
      'deleted_at',
      'execution_refs',
      'id',
      'input_state_version',
      'intervention_mode',
      'intervention_sessions',
      'parent_run_id',
      'status',
      'updated_at',
      'updated_by',
      'work_id',
    ]);
  });

  it('Hold fields', () => {
    expect(fieldNames(holdSchema.shape)).toEqual([
      'applicability',
      'asset_refs',
      'blocks_delivery',
      'created_at',
      'deleted_at',
      'fowler_quadrant',
      'id',
      'kind',
      'project_id',
      'registered_by',
      'registered_during_work',
      'severity',
      'source_event_ids',
      'statement',
      'status',
      'updated_at',
      'updated_by',
    ]);
  });

  it('Participant fields', () => {
    expect(fieldNames(participantSchema.shape)).toEqual([
      'created_at',
      'deleted_at',
      'display_name',
      'id',
      'project_id',
      'role',
      'type',
      'updated_at',
      'updated_by',
    ]);
  });

  it('Equip fields', () => {
    expect(fieldNames(equipSchema.shape)).toEqual([
      'allowed_actions',
      'id',
      'participant_id',
      'schema_snapshot_version',
      'state_version',
      'status',
      'work_id',
    ]);
  });

  it('Checkpoint fields', () => {
    expect(fieldNames(checkpointSchema.shape)).toEqual([
      'captured_at',
      'id',
      'position',
      'reason',
      'resume_ref',
      'state_version',
      'work_id',
    ]);
  });
});

describe('baseline guard: enum sets equal the accepted baseline', () => {
  it('Project.status is exactly the four-value baseline', () => {
    const values = (projectSchema.shape.status.options as string[]).slice().sort();
    expect(values).toEqual(['active', 'archived', 'completed', 'paused']);
  });

  it('Work.status is exactly the five-value baseline', () => {
    const values = (workSchema.shape.status.options as string[]).slice().sort();
    expect(values).toEqual(['blocked', 'cancelled', 'completed', 'in_progress', 'planned']);
  });

  it('Asset.kind is exactly the seven-value baseline', () => {
    const values = (assetSchema.shape.kind.options as string[]).slice().sort();
    expect(values).toEqual([
      'artifact',
      'context',
      'evidence',
      'experience',
      'knowledge',
      'skill',
      'template',
    ]);
  });

  it('Asset.scope is exactly the five-level baseline', () => {
    const values = (assetSchema.shape.scope.options as string[]).slice().sort();
    expect(values).toEqual(['organization', 'participant', 'project', 'session', 'task']);
  });

  it('Asset.lifecycle is exactly the seven-state baseline', () => {
    const values = (assetSchema.shape.lifecycle.options as string[]).slice().sort();
    expect(values).toEqual([
      'active',
      'archived',
      'candidate',
      'competitive_superseded',
      'deprecated',
      'rejected',
      'superseded',
    ]);
  });

  it('Hold.status is exactly the six-state baseline', () => {
    const values = (holdSchema.shape.status.options as string[]).slice().sort();
    expect(values).toEqual([
      'accepted',
      'active',
      'dormant',
      'invalidated',
      'registered',
      'resolved',
    ]);
  });

  it('Hold.kind is exactly the six-value baseline', () => {
    const values = (holdSchema.shape.kind.options as string[]).slice().sort();
    expect(values).toEqual([
      'bug',
      'deferred_decision',
      'known_risk',
      'skipped_edge_case',
      'tech_debt',
      'unvalidated_assumption',
    ]);
  });

  it('WorkRun.status is exactly the nine-state baseline', () => {
    const values = (workRunSchema.shape.status.options as string[]).slice().sort();
    expect(values).toEqual([
      'cancelled',
      'cancelling',
      'completed',
      'failed',
      'paused',
      'ready',
      'running',
      'waiting_approval',
      'waiting_input',
    ]);
  });

  it('Hold.severity is exactly the five-value baseline', () => {
    const values = (holdSeveritySchema.options as string[]).slice().sort();
    expect(values).toEqual(['critical', 'high', 'info', 'low', 'medium']);
  });

  it('Fowler quadrant is exactly the four-value baseline', () => {
    const values = (fowlerQuadrantSchema.options as string[]).slice().sort();
    expect(values).toEqual([
      'prudent_deliberate',
      'prudent_inadvertent',
      'reckless_deliberate',
      'reckless_inadvertent',
    ]);
  });

  it('Acceptance enums match the baseline', () => {
    expect((acceptanceResultSchema.options as string[]).slice().sort()).toEqual([
      'accepted',
      'conditional',
      'rejected',
    ]);
    expect((acceptanceTargetTypeSchema.options as string[]).slice()).toEqual(['Asset']);
  });

  it('Delivery enums match the baseline', () => {
    expect((deliveryTargetTypeSchema.options as string[]).slice().sort()).toEqual([
      'business_process',
      'customer_confirmation',
      'external_system',
      'production',
      'staging',
    ]);
    expect((deliveryConfirmationStatusSchema.options as string[]).slice().sort()).toEqual([
      'confirmed',
      'delivered',
      'pending',
      'rejected',
    ]);
  });

  it('Participant and Equip enums match the baseline', () => {
    expect((participantTypeSchema.options as string[]).slice().sort()).toEqual(['agent', 'human']);
    expect((equipStatusSchema.options as string[]).slice().sort()).toEqual([
      'active',
      'expired',
      'stale',
    ]);
  });

  it('Intervention mode and content storage enums match the baseline', () => {
    expect((interventionModeSchema.options as string[]).slice().sort()).toEqual([
      'assist',
      'observe',
      'takeover',
    ]);
    expect((assetContentStorageSchema.options as string[]).slice().sort()).toEqual([
      'external_ref',
      'inline',
      'local_ref',
      'object_ref',
    ]);
  });

  describe('positive constructions: one valid instance per type', () => {
    const project = {
      id: uuidv7(),
      title: 'p',
      status: 'completed',
      current_state_version: 2,
      created_at: NOW,
    };
    const work = {
      id: uuidv7(),
      created_at: NOW,
      project_id: uuidv7(),
      title: 'w',
      status: 'in_progress',
    };
    const taskspace = { id: uuidv7(), created_at: NOW, work_id: work.id };
    const participant = {
      id: uuidv7(),
      created_at: NOW,
      project_id: project.id,
      type: 'agent',
    };
    const equip = {
      id: uuidv7(),
      state_version: 1,
      status: 'active',
      work_id: work.id,
      participant_id: participant.id,
    };

    it('Work, TaskSpace, Participant, Equip construct validly', () => {
      expect(workSchema.safeParse(work).success).toBe(true);
      expect(taskspaceSchema.safeParse(taskspace).success).toBe(true);
      expect(participantSchema.safeParse(participant).success).toBe(true);
      expect(equipSchema.safeParse(equip).success).toBe(true);
    });

    it('fowler_quadrant accepts a valid tech_debt hold', () => {
      const hold = {
        id: uuidv7(),
        created_at: NOW,
        project_id: project.id,
        kind: 'tech_debt',
        severity: 'high',
        status: 'active',
        blocks_delivery: true,
        statement: 'missing index',
        registered_by: participant.id,
        fowler_quadrant: 'prudent_deliberate',
      };
      expect(holdSchema.safeParse(hold).success).toBe(true);
    });

    it('Delivery constructs with confirmed identity and pending status', () => {
      const base = {
        id: uuidv7(),
        created_at: NOW,
        asset_id: uuidv7(),
        target_ref: 'https://example.test',
        target_type: 'staging',
        dispatched_at: NOW,
        version: 'a'.repeat(64),
        attempt_no: 1,
      };
      expect(deliverySchema.safeParse({ ...base, confirmation_status: 'pending' }).success).toBe(
        true,
      );
      expect(
        deliverySchema.safeParse({
          ...base,
          confirmation_status: 'confirmed',
          confirmed_by: participant.id,
          confirmed_at: NOW,
        }).success,
      ).toBe(true);
    });

    it('WorkRun constructs across its status surface', () => {
      const base = {
        id: uuidv7(),
        created_at: NOW,
        work_id: work.id,
      };
      for (const status of [
        'ready',
        'running',
        'waiting_input',
        'waiting_approval',
        'paused',
        'cancelling',
        'cancelled',
        'failed',
        'completed',
      ]) {
        expect(workRunSchema.safeParse({ ...base, status }).success).toBe(true);
      }
    });

    it('Project constructs across its status surface', () => {
      for (const status of ['active', 'paused', 'completed', 'archived']) {
        expect(projectSchema.safeParse({ ...project, status }).success).toBe(true);
      }
    });

    it('Asset scope and content storage surface', () => {
      const base = {
        id: uuidv7(),
        created_at: NOW,
        project_id: uuidv7(),
        kind: 'knowledge',
        scope: 'project',
        lifecycle: 'active',
      };
      for (const scope of ['participant', 'session', 'task', 'project', 'organization']) {
        expect(assetSchema.safeParse({ ...base, scope }).success).toBe(true);
      }
      // storage routing per the baseline: inline rides event payloads (no ref),
      // object_ref/local_ref/external_ref each require their pointer.
      expect(
        assetSchema.safeParse({
          ...base,
          content: { media_type: 'text/markdown', storage: 'inline', sha256: 'b'.repeat(64) },
        }).success,
      ).toBe(true);
      for (const [storage, ref] of [
        ['object_ref', 'objects/abc/content.md'],
        ['local_ref', 'sha256:1111111111111111111111111111111111111111111111111111111111111111'],
        ['external_ref', 'https://example.com/artifact.tar.gz'],
      ] as const) {
        expect(
          assetSchema.safeParse({
            ...base,
            content: { media_type: 'text/markdown', storage, ref },
          }).success,
        ).toBe(true);
      }
    });

    it('privacy_class accepts all three evidence classes', () => {
      for (const privacy_class of ['evidence', 'work', 'audit']) {
        expect(eventEnvelopeSchema.safeParse({ ...envelopeBase, privacy_class }).success).toBe(
          true,
        );
      }
    });
  });
});

describe('field conventions guard (no CRUD base model)', () => {
  const allSchemas = {
    Acceptance: acceptanceSchema,
    Asset: assetSchema,
    Checkpoint: checkpointSchema,
    Delivery: deliverySchema,
    Equip: equipSchema,
    Hold: holdSchema,
    Participant: participantSchema,
    Project: projectSchema,
    TaskSpace: taskspaceSchema,
    Work: workSchema,
    WorkRun: workRunSchema,
  };

  it('governed base-model fields only: no boolean deleted, no untyped ext, no ungoverned audit columns', () => {
    for (const [name, schema] of Object.entries(allSchemas)) {
      const fields = Object.keys(schema.shape);
      expect(fields, `${name} must not carry a boolean soft-delete flag`).not.toContain('deleted');
      expect(fields, `${name} must not carry an untyped ext column`).not.toContain('ext');
      if (!['Equip', 'Checkpoint'].includes(name)) {
        for (const f of ['created_at', 'deleted_at', 'updated_at', 'updated_by']) {
          expect(fields, `${name} must carry governed base-model field ${f}`).toContain(f);
        }
      }
    }
  });

  /**
   * Replay-write guard: updated_at/updated_by exist as event-derived
   * read caches, so nothing in the schema layer may mark them
   * command-writable — every mutation surface must default them to
   * null (replay fills them). A schema that turns them required or
   * command-supplied breaks the single-writer rule.
   */
  it('tombstone consistency: deleted_at, when present, is a valid instant (null = live)', () => {
    for (const [name, schema] of Object.entries(allSchemas)) {
      if (['Equip', 'Checkpoint'].includes(name)) continue;
      const shape = schema.shape as Record<string, z.ZodType | undefined>;
      const deletedAt = shape['deleted_at'];
      const probe = deletedAt?.safeParse(null);
      expect(probe?.success ?? true, `${name}.deleted_at must accept null (null = live)`).toBe(
        true,
      );
      const past = deletedAt?.safeParse('2026-01-01T00:00:00.000Z');
      expect(past?.success ?? true, `${name}.deleted_at must accept a valid instant`).toBe(true);
    }
  });

  it('updated_at/updated_by are replay-only caches: optional+nullable, never command-required', () => {
    for (const [name, schema] of Object.entries(allSchemas)) {
      if (!['Equip', 'Checkpoint'].includes(name)) {
        const shape = schema.shape as Record<string, z.ZodType | undefined>;
        const updatedAt = shape['updated_at'];
        const updatedBy = shape['updated_by'];
        // constructing without the cache fields must succeed (replay fills them)
        expect(
          updatedAt?.safeParse(undefined).success ?? true,
          `${name}.updated_at must accept undefined (replay fills it)`,
        ).toBe(true);
        expect(
          updatedBy?.safeParse(undefined).success ?? true,
          `${name}.updated_by must accept undefined (replay fills it)`,
        ).toBe(true);
      }
    }
  });

  it('no unknown extra keys are accepted (strict objects)', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'knowledge',
      scope: 'project',
      lifecycle: 'candidate',
      local_invention: 'oops',
    });
    expect(result.success).toBe(false);
  });
});

describe('valid construction of each type', () => {
  it('constructs a valid Project', () => {
    const result = projectSchema.safeParse({
      id: uuidv7(),
      created_at: NOW,
      deleted_at: null,
      updated_at: null,
      updated_by: null,
      title: '商家入驻平台',
      purpose: '让商家在三天内完成入驻并开始销售',
      status: 'active',
      current_state_version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid Asset with content carrier and reserved fields inert', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'artifact',
      scope: 'task',
      lifecycle: 'candidate',
      provenance: '从 W-1 的 Return 提交',
      content: { media_type: 'text/typescript', storage: 'inline' },
      valid_from: null,
      valid_to: null,
    });
    expect(result.success).toBe(true);
  });

  it('constructs an organization-scope Asset without project_id', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      created_at: NOW,
      kind: 'knowledge',
      scope: 'organization',
      lifecycle: 'candidate',
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid Acceptance with rationale on conditional', () => {
    const result = acceptanceSchema.safeParse({
      id: uuidv7(),
      created_at: NOW,
      target_ref: uuidv7(),
      target_type: 'Asset',
      actor: uuidv7(),
      result: 'conditional',
      rationale: '覆盖率达到 91%，但边界用例 E-7 未过',
      criteria_snapshot: { criteria: ['覆盖率 ≥ 90%'], version: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid Delivery with confirmation flow', () => {
    const result = deliverySchema.safeParse({
      id: uuidv7(),
      asset_id: uuidv7(),
      created_at: NOW,
      target_ref: 'staging-cluster-1',
      target_type: 'staging',
      dispatched_at: NOW,
      version: 'a'.repeat(64),
      attempt_no: 1,
      confirmation_status: 'delivered',
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid Hold with full audit chain', () => {
    const result = holdSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'tech_debt',
      severity: 'high',
      status: 'registered',
      blocks_delivery: false,
      statement: 'sub_orders 与 W2 的对接未完成',
      registered_by: uuidv7(),
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid WorkRun', () => {
    const result = workRunSchema.safeParse({
      id: uuidv7(),
      work_id: uuidv7(),
      created_at: NOW,
      status: 'ready',
    });
    expect(result.success).toBe(true);
  });

  it('constructs a valid Checkpoint with resume anchor', () => {
    const result = checkpointSchema.safeParse({
      id: uuidv7(),
      work_id: uuidv7(),
      captured_at: NOW,
      state_version: 7,
      position: { step: 'outline-done' },
      resume_ref: { runtime: 'session-12' },
    });
    expect(result.success).toBe(true);
  });
});

describe('invalid construction is rejected with field-level detail', () => {
  it('rejects an illegal lifecycle value naming the field', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'knowledge',
      scope: 'project',
      lifecycle: 'fortnite',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('lifecycle'));
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(['lifecycle']);
    }
  });

  it('rejects content.storage outside the enum', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'artifact',
      scope: 'task',
      lifecycle: 'candidate',
      content: { media_type: 'text/plain', storage: 'cloud', ref: 'x' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.').startsWith('content.storage'))).toBe(
        true,
      );
    }
  });

  it('rejects pointer-class content with no ref and inline content that carries one', () => {
    const base = {
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'artifact',
      scope: 'task',
      lifecycle: 'candidate',
    };
    const noRef = assetSchema.safeParse({
      ...base,
      content: { media_type: 'text/plain', storage: 'object_ref' },
    });
    expect(noRef.success).toBe(false);
    const inlineRef = assetSchema.safeParse({
      ...base,
      content: { media_type: 'text/plain', storage: 'inline', ref: 'internal://doc' },
    });
    expect(inlineRef.success).toBe(false);
  });

  it('rejects a project-scope Asset without project_id (ownership anchor)', () => {
    const result = assetSchema.safeParse({
      id: uuidv7(),
      created_at: NOW,
      kind: 'knowledge',
      scope: 'project',
      lifecycle: 'candidate',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('project_id'))).toBe(true);
    }
  });

  it('rejects a Hold without statement (problem body is required)', () => {
    const result = holdSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'bug',
      severity: 'high',
      status: 'registered',
      blocks_delivery: false,
      registered_by: uuidv7(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('statement'))).toBe(true);
    }
  });

  it('rejects fowler_quadrant on a non-tech_debt Hold (cross-field rule)', () => {
    const result = holdSchema.safeParse({
      id: uuidv7(),
      project_id: uuidv7(),
      created_at: NOW,
      kind: 'bug',
      severity: 'high',
      status: 'registered',
      blocks_delivery: false,
      statement: '登录接口 500',
      fowler_quadrant: 'prudent_deliberate',
      registered_by: uuidv7(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('fowler_quadrant'))).toBe(true);
    }
  });

  it('rejects an Acceptance without criteria_snapshot (judgment anchor required)', () => {
    const result = acceptanceSchema.safeParse({
      id: uuidv7(),
      created_at: NOW,
      target_ref: uuidv7(),
      target_type: 'Asset',
      actor: uuidv7(),
      result: 'accepted',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('criteria_snapshot'))).toBe(true);
    }
  });

  it('rejects a Delivery confirmed without confirmer identity (confirmation accountability)', () => {
    const result = deliverySchema.safeParse({
      id: uuidv7(),
      asset_id: uuidv7(),
      created_at: NOW,
      target_ref: 'proc-system',
      target_type: 'business_process',
      dispatched_at: NOW,
      version: 'b'.repeat(64),
      attempt_no: 2,
      confirmation_status: 'confirmed',
    });
    expect(result.success).toBe(false);
  });
});

describe('acceptance rationale rule', () => {
  const base = () => ({
    id: uuidv7(),
    created_at: NOW,
    target_ref: uuidv7(),
    target_type: 'Asset' as const,
    actor: uuidv7(),
    criteria_snapshot: { criteria: ['默认标准'], version: 1 },
  });

  it('rejects a rejected verdict without rationale, pointing at rationale', () => {
    const result = acceptanceSchema.safeParse({ ...base(), result: 'rejected' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('rationale'))).toBe(true);
    }
  });

  it('rejects a conditional verdict with empty rationale', () => {
    const result = acceptanceSchema.safeParse({ ...base(), result: 'conditional', rationale: '' });
    expect(result.success).toBe(false);
  });

  it('accepts an accepted verdict with null rationale', () => {
    const result = acceptanceSchema.safeParse({ ...base(), result: 'accepted' });
    expect(result.success).toBe(true);
  });

  it('keeps two independent judgments append-only at the domain layer', () => {
    const first = acceptanceSchema.parse({
      ...base(),
      result: 'conditional',
      rationale: '缺边界用例',
    });
    const second = acceptanceSchema.parse({
      ...base(),
      result: 'accepted',
      rationale: '补齐后通过',
    });
    expect(first.id).not.toBe(second.id);
    expect(first.result).toBe('conditional');
    expect(second.result).toBe('accepted');
  });
});
