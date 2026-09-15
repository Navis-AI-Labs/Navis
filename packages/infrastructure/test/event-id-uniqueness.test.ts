import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryEventStore } from '../src/persistence/in-memory/in-memory-event-store.js';
import type { EventEnvelope } from '@navis/domain';

describe('Event ID uniqueness - both adapters', () => {
  let store: InMemoryEventStore;
  const PROJECT_A = '0198b100-0000-7000-8000-000000000001';
  const PROJECT_B = '0198b100-0000-7000-8000-000000000002';
  const NOW = '2024-01-01T00:00:00.000Z';

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  function makeEvent(eventId: string, projectId: string, seq: number): EventEnvelope {
    return {
      event_id: eventId,
      project_id: projectId,
      seq,
      aggregate_type: 'project',
      aggregate_id: projectId,
      aggregate_revision: 1,
      event_type: 'participant.registered',
      event_schema_version: 1,
      occurred_at: NOW,
      recorded_at: NOW,
      actor_participant_id: '0198b100-0000-7000-8000-000000000099',
      payload: {
        participant_id: '0198b100-0000-7000-8000-000000000099',
        type: 'human',
      },
      metadata: {},
      privacy_class: 'audit',
      state_version: 0,
    };
  }

  describe('rejects duplicate event_id within same batch', () => {
    it('throws event-id-conflict when two events in same batch share event_id', async () => {
      const event1 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 1);
      const event2 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 2); // duplicate event_id

      await expect(store.append(PROJECT_A, [event1, event2], 0)).rejects.toThrow(
        /event-id-conflict/,
      );

      // Stream should remain empty (all-or-nothing)
      const events = await store.loadEvents(PROJECT_A, 0);
      expect(events).toHaveLength(0);
    });
  });

  describe('rejects duplicate event_id across batches in same project', () => {
    it('throws event-id-conflict when appending event with existing event_id', async () => {
      const event1 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 1);
      await store.append(PROJECT_A, [event1], 0);

      const event2 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 2); // duplicate event_id
      await expect(store.append(PROJECT_A, [event2], 1)).rejects.toThrow(/event-id-conflict/);

      // Stream should only contain first event
      const events = await store.loadEvents(PROJECT_A, 0);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_id).toBe('0198b100-0000-7000-8000-000000000100');
    });
  });

  describe('rejects duplicate event_id across different projects', () => {
    it('throws event-id-conflict when event_id already exists in another project', async () => {
      const eventA = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 1);
      await store.append(PROJECT_A, [eventA], 0);

      const eventB = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_B, 1); // same event_id, different project
      await expect(store.append(PROJECT_B, [eventB], 0)).rejects.toThrow(/event-id-conflict/);

      // Project A should have its event
      const eventsA = await store.loadEvents(PROJECT_A, 0);
      expect(eventsA).toHaveLength(1);

      // Project B should remain empty
      const eventsB = await store.loadEvents(PROJECT_B, 0);
      expect(eventsB).toHaveLength(0);
    });
  });

  describe('allows same event_id to be reused after the owning project is cleared (theoretical)', () => {
    it('prevents event_id reuse even after manual stream deletion', async () => {
      const event1 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_A, 1);
      await store.append(PROJECT_A, [event1], 0);

      // Manually clear the stream (simulates deletion, though not part of public API)
      // @ts-expect-error - accessing private field for test
      store.streams.delete(PROJECT_A);

      // Try to append same event_id to a different project
      const event2 = makeEvent('0198b100-0000-7000-8000-000000000100', PROJECT_B, 1);
      await expect(store.append(PROJECT_B, [event2], 0)).rejects.toThrow(/event-id-conflict/);

      // The eventIds map still tracks ownership
      // @ts-expect-error - accessing private field for test
      expect(store.eventIds.get('0198b100-0000-7000-8000-000000000100')).toBe(PROJECT_A);
    });
  });

  describe('all-or-nothing guarantee', () => {
    it('rejects entire batch when last event has duplicate event_id', async () => {
      const event1 = makeEvent('0198b100-0000-7000-8000-000000000101', PROJECT_A, 1);
      await store.append(PROJECT_A, [event1], 0);

      const event2 = makeEvent('0198b100-0000-7000-8000-000000000102', PROJECT_A, 2);
      const event3 = makeEvent('0198b100-0000-7000-8000-000000000103', PROJECT_A, 3);
      const event4 = makeEvent('0198b100-0000-7000-8000-000000000101', PROJECT_A, 4); // duplicate from first batch

      await expect(store.append(PROJECT_A, [event2, event3, event4], 1)).rejects.toThrow(
        /event-id-conflict/,
      );

      // None of the second batch should be stored
      const events = await store.loadEvents(PROJECT_A, 0);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_id).toBe('0198b100-0000-7000-8000-000000000101');
    });
  });
});
