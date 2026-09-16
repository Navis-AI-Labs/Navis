/**
 * Golden fixtures for the canonical work event: one valid event per
 * event_type. Fixtures are hand-maintained pins of the public contract —
 * never generated from server code — so that an accidental contract move
 * fails a test here before any consumer breaks.
 */

export const fixtureIds = {
  project: '01923a61-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
  work: '01923a61-7a1c-7d2e-8f4a-5b6c7d8e9f0a',
  equip: '01923a61-7a1d-7e3f-905b-6c7d8e9f0a1b',
  checkpoint: '01923a61-7a1e-7f4a-916c-7d8e9f0a1b2c',
} as const;

const envelope = {
  schema_version: 1,
  occurred_at: '2026-09-14T08:30:00.000Z',
  project_id: fixtureIds.project,
  source_runtime: 'claude-code',
  source_session_id: 'session-0192ab',
  raw_ref: 'transcript://session-0192ab#turn-42',
  extractor_version: 'bridge-extractor/0.3.1',
  confidence: 0.92,
  review_status: 'pending',
} as const;

/** One valid fixture per closed-enum event type (v1 = six variants). */
export const canonicalWorkEventFixtures = [
  { ...envelope, event_type: 'work.started', payload: { work_id: fixtureIds.work } },
  {
    ...envelope,
    event_type: 'work.progressed',
    payload: { work_id: fixtureIds.work, note: 'halfway through the acceptance sweep' },
  },
  {
    ...envelope,
    event_type: 'work.returned',
    payload: { work_id: fixtureIds.work, equip_id: fixtureIds.equip, summary: 'returned clean' },
  },
  {
    ...envelope,
    event_type: 'checkpoint.suggested',
    payload: { reason: 'reviewer rejected the draft twice', checkpoint_id: fixtureIds.checkpoint },
  },
  {
    ...envelope,
    event_type: 'evidence.captured',
    payload: {
      raw_ref: 'transcript://session-0192ab#turn-43',
      note: 'screenshot of the failing test',
    },
  },
  {
    ...envelope,
    event_type: 'candidate.proposed',
    payload: { kind: 'asset', content: { title: 'captured asset', summary: 'from transcript' } },
  },
] as const;
