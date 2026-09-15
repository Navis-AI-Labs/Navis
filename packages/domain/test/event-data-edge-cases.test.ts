import { describe, it, expect } from 'vitest';
import { parseEventData } from '../src/state/event-data.js';

describe('Event data edge cases', () => {
  it('throws error for unknown event type', () => {
    expect(() => {
      parseEventData('unknown.event.type', {});
    }).toThrow('unknown event type unknown.event.type');
  });

  it('throws detailed error message for schema violation when issues array exists', () => {
    expect(() => {
      parseEventData('project.created', { project_id: 'not-a-uuid', title: '' });
    }).toThrow(); // Zod will throw with validation details
  });
});
