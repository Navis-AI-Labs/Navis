import { describe, it, expect } from 'vitest';
import { EventHistory } from '../src/state/event-history.js';

describe('Event history edge cases', () => {
  describe('line 48: error message fallback', () => {
    it('handles Zod error with empty issues array', () => {
      const history = new EventHistory();

      // Create a malformed event that will trigger validation error
      const invalidEvent = {
        seq: 1,
        type: 'invalid.type',
        data: null, // invalid: should be Record<string, JSONType>
        actor: 'actor-id',
        at: '2026-09-02T00:00:00.000Z',
        state_version: 0,
        schema_version: 1,
      };

      expect(() => history.append(invalidEvent)).toThrow();
    });

    it('handles errors with formatted issue messages', () => {
      const history = new EventHistory();

      // Create event with invalid structure that will have detailed issues
      const invalidEvent = {
        seq: 1,
        type: 'project.created',
        data: { invalid_field: 'value' }, // missing required fields
        actor: null, // invalid actor
        at: 'not-a-date', // invalid date
        state_version: -1, // invalid version
        schema_version: 1,
      };

      expect(() => history.append(invalidEvent)).toThrow(/invalid event/);
    });
  });

  describe('seq validation', () => {
    it('throws error when seq does not continue from head', () => {
      const history = new EventHistory();

      // Append first valid event
      history.append({
        seq: 1,
        type: 'participant.registered',
        data: { participant_id: '01900000-0000-7000-8000-000000000001', type: 'human' },
        actor: '01900000-0000-7000-8000-000000000001',
        at: '2026-01-01T00:00:00.000Z',
        state_version: 0,
        schema_version: 1,
      });

      // Try to append with wrong seq (should be 2, not 3)
      expect(() => {
        history.append({
          seq: 3,
          type: 'participant.registered',
          data: { participant_id: '01900000-0000-7000-8000-000000000002', type: 'agent' },
          actor: '01900000-0000-7000-8000-000000000001',
          at: '2026-01-01T00:00:00.000Z',
          state_version: 0,
          schema_version: 1,
        });
      }).toThrow('version-conflict');
    });
  });
});
