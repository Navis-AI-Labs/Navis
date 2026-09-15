import { describe, expect, it } from 'vitest';

import { ProjectStateKernel } from '../src/state/project-state-kernel.js';
import { parseEventData } from '../src/state/event-data.js';
import type { StateEvent } from '../src/state/events.js';

const HUMAN = '0198b100-0000-7000-8000-000000000001';
const AT = '2026-09-02T00:00:00.000Z';

describe('Event data validation', () => {
  describe('parseEventData', () => {
    it('throws for unknown event type', () => {
      expect(() => parseEventData('unknown.event.type', {})).toThrow(
        'unknown event type unknown.event.type',
      );
    });

    it('parses known event types successfully', () => {
      const result = parseEventData('participant.registered', {
        participant_id: HUMAN,
        type: 'human',
      });
      expect(result).toEqual({ participant_id: HUMAN, type: 'human' });
    });
  });

  describe('on write (append)', () => {
    it('rejects events with invalid payload during command execution', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      // Invalid project.created: missing required title
      const result = k.createProject({
        actor: HUMAN,
        at: AT,
        title: '', // empty title violates min(1)
        expected_version: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details?.['reason']).toBe('invalid-fields');
      }
    });

    it('validates acceptance.recorded rationale requirement', () => {
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

      // rejection without rationale should fail
      const result = k.acceptAsset({
        actor: HUMAN,
        at: AT,
        asset_id: assetResult.value.id,
        result: 'rejected',
        criteria_snapshot: {},
        expected_version: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rationale-required');
      }
    });
  });

  describe('on replay (restore from snapshot)', () => {
    it('rejects events with invalid payload structure during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      // Create a valid event sequence first
      k.createProject({ actor: HUMAN, at: AT, title: 'Valid Project', expected_version: 0 });

      const validEvents = k.events;

      // Manually craft an invalid event with wrong payload structure
      const invalidEvent: StateEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: {
          project_id: '0198b100-0000-7000-8000-000000000999',
          title: 123, // should be string, not number
        },
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      // Replay should reject the invalid event
      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('rejects events with empty issues array during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Craft an event that will cause schema validation error with no issues
      const invalidEvent: StateEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: {
          project_id: '0198b100-0000-7000-8000-000000000999',
          title: null, // null instead of string
        },
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('rejects events with missing required fields during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Manually craft an event missing required fields
      const invalidEvent: StateEvent = {
        seq: validEvents.length + 1,
        type: 'work.created',
        data: {
          work_id: '0198b100-0000-7000-8000-000000000100',
          project_id: '0198b100-0000-7000-8000-000000000101',
          // missing: title, reason, actor
        },
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('rejects events violating cross-field constraints during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // acceptance.recorded with rejected result but missing rationale
      const invalidEvent: StateEvent = {
        seq: validEvents.length + 1,
        type: 'acceptance.recorded',
        data: {
          acceptance_id: '0198b100-0000-7000-8000-000000000100',
          asset_id: '0198b100-0000-7000-8000-000000000101',
          result: 'rejected',
          // missing: rationale (required for rejected)
          criteria_snapshot: {},
          actor: HUMAN,
        },
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('handles non-Error exceptions during projection validation', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });
      k.createProject({ actor: HUMAN, at: AT, title: 'Valid Project', expected_version: 0 });

      const validEvents = k.events;

      // Craft an event that will trigger non-Error exception
      const invalidEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: {
          project_id: '0198b100-0000-7000-8000-000000000999',
          title: { nested: 'object' },
        },
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      } as StateEvent;

      // Replay should reject the invalid event
      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('rejects events with missing issue message in error', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Event with completely invalid structure that produces error without issues[0].message
      const invalidEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: {} as Record<string, never>,
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('rejects duplicate participant registration during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Manually craft a duplicate participant.registered event
      const duplicateEvent: StateEvent = {
        seq: validEvents.length + 1,
        type: 'participant.registered',
        data: {
          participant_id: HUMAN, // duplicate
          type: 'human',
        },
        actor: null,
        at: AT,
        state_version: 0,
        schema_version: 1,
      };

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, duplicateEvent]);
      }).toThrow(/duplicate participant/);
    });

    it('rejects event with malformed Zod error (no issues array)', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Craft an event with completely invalid structure to trigger Zod error without issues
      const invalidEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: null,
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      } as unknown as StateEvent;

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
      }).toThrow();
    });

    it('falls back to generic message when Zod error has no issues', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Craft event that will fail StateEvent parsing with empty issues
      const invalidEvent = {
        seq: validEvents.length + 1,
        type: 'project.created',
        data: {},
        actor: HUMAN,
        at: 'not-a-date',
        state_version: 0,
        schema_version: 1,
      } as unknown as StateEvent;

      try {
        ProjectStateKernel.fromEvents([...validEvents, invalidEvent]);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/invalid event/);
      }
    });

    it('rejects unknown event type during replay', () => {
      const k = new ProjectStateKernel();
      k.registerParticipant({ participant_id: HUMAN, type: 'human', at: AT });

      const validEvents = k.events;

      // Craft event with unknown type
      const unknownEvent = {
        seq: validEvents.length + 1,
        type: 'unknown.event.type',
        data: {},
        actor: HUMAN,
        at: AT,
        state_version: 0,
        schema_version: 1,
      } as unknown as StateEvent;

      expect(() => {
        ProjectStateKernel.fromEvents([...validEvents, unknownEvent]);
      }).toThrow(/unknown event type/);
    });
  });
});
