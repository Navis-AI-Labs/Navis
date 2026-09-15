import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/state/project-state-kernel.js';

const AT = '2026-09-13T10:00:00.000Z';
const HUMAN = '0198b100-0000-7000-8000-000000000001';

describe('Command field validation', () => {
  describe('textSchema fields must not be whitespace-only', () => {
    it('rejects createProject with whitespace-only title', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      const result = k.createProject({
        actor: HUMAN,
        at: AT,
        title: '   ',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('title')).toBe(true);
      }
    });

    it('rejects createProject with whitespace-only purpose', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      const result = k.createProject({
        actor: HUMAN,
        at: AT,
        title: 'Valid Title',
        purpose: '   ',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('purpose')).toBe(true);
      }
    });

    it('rejects createProject with whitespace-only boundary', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      const result = k.createProject({
        actor: HUMAN,
        at: AT,
        title: 'Valid Title',
        boundary: '   ',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('boundary')).toBe(true);
      }
    });

    it('rejects createWork with whitespace-only title', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      const result = k.createWork({
        actor: HUMAN,
        at: AT,
        title: '   ',
        reason: 'test',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('title')).toBe(true);
      }
    });

    it('rejects createWork with whitespace-only reason', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      const result = k.createWork({
        actor: HUMAN,
        at: AT,
        title: 'Valid',
        reason: '   ',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rationale-required');
      }
    });

    it('rejects createWork with whitespace-only direction', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      const result = k.createWork({
        actor: HUMAN,
        at: AT,
        title: 'Valid',
        reason: 'test',
        direction: '   ',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('direction')).toBe(true);
      }
    });

    it('rejects redirectWork with whitespace-only direction', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      const workResult = k.createWork({
        actor: HUMAN,
        at: AT,
        title: 'Valid',
        reason: 'test',
        expected_version: 0,
      });
      expect(workResult.ok).toBe(true);
      if (!workResult.ok) return;
      const result = k.redirectWork({
        actor: HUMAN,
        at: AT,
        work_id: workResult.value.id,
        direction: '   ',
        reason: 'test',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('direction')).toBe(true);
      }
    });

    it('rejects deliver with whitespace-only target_ref', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      const assetResult = k.createAsset({
        actor: HUMAN,
        at: AT,
        kind: 'artifact',
        scope: 'project',
        content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
        expected_version: 0,
      });
      expect(assetResult.ok).toBe(true);
      if (!assetResult.ok) return;
      const acceptResult = k.acceptAsset({
        actor: HUMAN,
        at: AT,
        asset_id: assetResult.value.id,
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: 0,
      });
      expect(acceptResult.ok).toBe(true);
      if (!acceptResult.ok) return;
      const result = k.deliver({
        actor: HUMAN,
        at: AT,
        asset_id: assetResult.value.id,
        target_ref: '   ',
        target_type: 'production',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('target_ref')).toBe(true);
      }
    });
  });

  describe('textSchema array elements must not be whitespace-only', () => {
    it('rejects createProject with whitespace-only acceptance_criteria element', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      const result = k.createProject({
        actor: HUMAN,
        at: AT,
        title: 'Valid Title',
        acceptance_criteria: ['Valid criterion', '   ', 'Another valid'],
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes('acceptance_criteria')).toBe(
          true,
        );
      }
    });
  });

  // Command-field admission: a command carrying a malformed field is refused
  // before append; the ledger, projection, and causal clock stay untouched.
  describe('malformed non-text fields are rejected without polluting the ledger', () => {
    const seeded = () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'P', expected_version: 0 });
      return k;
    };

    const expectRejectedUnchanged = (
      k: ProjectStateKernel,
      result: { ok: boolean; error?: { code: string; details?: Record<string, unknown> } },
      field: string,
      eventsBefore: number,
    ) => {
      expect(result.ok).toBe(false);
      if (!result.ok && result.error !== undefined) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
        expect((result.error.details?.['fields'] as string[]).includes(field)).toBe(true);
      }
      expect(k.events).toHaveLength(eventsBefore);
    };

    it('rejects registerParticipant with a non-UUID participant id', () => {
      const k = new ProjectStateKernel();
      const result = k.registerParticipant({
        participant_id: 'not-a-uuid',
        type: 'human',
        at: AT,
      });
      expectRejectedUnchanged(k, result, 'participant_id', 0);
    });

    it('rejects createProject when the actor is not a registered participant', () => {
      const k = new ProjectStateKernel();
      const unregistered = '0198b100-9999-7000-8000-000000000009';
      const result = k.createProject({
        actor: unregistered,
        at: AT,
        title: 'P',
        expected_version: 0,
      });
      expect(result.ok).toBe(false);
      expect(k.events).toHaveLength(0);
    });

    it('rejects updateBoundary with a non-instant timestamp', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.updateBoundary({
        actor: HUMAN,
        at: 'not-an-instant',
        reason: 'refine',
        boundary: 'new boundary',
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'at', before);
    });

    it('rejects setProjectStatus with an unknown target status', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.setProjectStatus({
        actor: HUMAN,
        at: AT,
        reason: 'pause work',
        to: 'bogus' as never,
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'to', before);
    });

    it('rejects createWork with a non-instant timestamp', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.createWork({
        actor: HUMAN,
        at: 'not-an-instant',
        title: 'T',
        reason: 'r',
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'at', before);
    });

    it('rejects createAsset with a non-instant timestamp', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.createAsset({
        actor: HUMAN,
        at: 'not-an-instant',
        kind: 'artifact',
        scope: 'project',
        content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'at', before);
    });

    it('rejects recordEffect with a non-instant timestamp', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.recordEffect({
        actor: HUMAN,
        at: 'not-an-instant',
        description: 'external check',
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'at', before);
    });

    it('rejects issueEquip when allowed_actions exceeds the admitted bound', () => {
      const k = seeded();
      const agent = '0198b100-0000-7000-8000-000000000002';
      k.registerParticipant({ participant_id: agent, type: 'agent', at: AT });
      const before = k.events.length;
      const result = k.issueEquip({
        actor: HUMAN,
        participant_id: agent,
        at: AT,
        allowed_actions: Array.from({ length: 101 }, () => 'act'),
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'allowed_actions', before);
    });

    it('rejects submitReturn with a non-UUID equip id', () => {
      const k = seeded();
      const before = k.events.length;
      const result = k.submitReturn({
        actor: HUMAN,
        at: AT,
        equip_id: 'not-a-uuid',
        expected_version: 0,
      });
      expectRejectedUnchanged(k, result, 'equip_id', before);
    });

    it('rejects deliver with an unknown delivery target type', () => {
      const k = seeded();
      const assetResult = k.createAsset({
        actor: HUMAN,
        at: AT,
        kind: 'artifact',
        scope: 'project',
        content: { media_type: 'text/plain', storage: 'inline', sha256: 'a'.repeat(64) },
        expected_version: 0,
      });
      expect(assetResult.ok).toBe(true);
      if (!assetResult.ok) return;
      const acceptResult = k.acceptAsset({
        actor: HUMAN,
        at: AT,
        asset_id: assetResult.value.id,
        result: 'accepted',
        criteria_snapshot: {},
        expected_version: k.stateVersion,
      });
      expect(acceptResult.ok).toBe(true);
      const before = k.events.length;
      const result = k.deliver({
        actor: HUMAN,
        at: AT,
        asset_id: assetResult.value.id,
        target_ref: 'main',
        target_type: 'bogus',
        expected_version: k.stateVersion,
      });
      expectRejectedUnchanged(k, result, 'target_type', before);
    });
  });
});
