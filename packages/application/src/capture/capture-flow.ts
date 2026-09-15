import type { EventEnvelope, EventStore, KernelProjection } from '@navis/domain';
import {
  canonicalEquals,
  evaluateCaptureDue,
  extractCaptureAnchor,
  projectionSnapshotSchema,
  serializeProjectionState,
  STATE_EVENT_SCHEMA_VERSION,
  validateSnapshotUsability,
  type CaptureTrigger,
  type StateEvent,
} from '@navis/domain';

export interface CaptureOutcome {
  readonly captured: boolean;
  readonly trigger: CaptureTrigger | null;
}

/**
 * Captures one committed observation. Marks precede the snapshot so a
 * failed save leaves only retryable annotations, never claimed coverage.
 */
export async function captureSnapshotIfDue(
  store: EventStore,
  events: readonly EventEnvelope[],
  projection: KernelProjection,
): Promise<CaptureOutcome> {
  const head = events.at(-1);
  if (head === undefined) return { captured: false, trigger: null };
  if (projection.project === null || projection.policy === null) {
    throw new Error('capture flow: projection carries no policy row');
  }
  const projectId = projection.project.id;
  if (
    projection.seq !== head.seq ||
    projection.project.current_state_version !== head.state_version ||
    events.some((event) => event.project_id !== projectId)
  ) {
    throw new Error('capture flow: events and projection do not describe the same observation');
  }

  // Own the complete observation before the first asynchronous boundary.
  const state = serializeProjectionState(projection);
  const observedEvents: StateEvent[] = events.map((event) => ({
    seq: event.seq,
    type: event.event_type,
    data: event.payload,
    actor: event.actor_participant_id ?? null,
    at: event.occurred_at,
    state_version: event.state_version,
    schema_version: event.event_schema_version,
  }));
  const snapshot = projectionSnapshotSchema.parse({
    state_version: head.state_version,
    seq: head.seq,
    schema_version: STATE_EVENT_SCHEMA_VERSION,
    state: { ...state, capture_anchor: { seq: head.seq, at: head.occurred_at } },
  });
  const valid = validateSnapshotUsability(snapshot, observedEvents, STATE_EVENT_SCHEMA_VERSION);
  if (!valid.ok) throw new Error('capture flow: ' + valid.reason);
  const policy = { ...projection.policy };

  const stored = await store.loadSnapshot(projectId);
  if (stored !== null && stored.seq > snapshot.seq) return { captured: false, trigger: null };
  if (stored?.seq === snapshot.seq) {
    if (!canonicalEquals(stored, snapshot))
      throw new Error('snapshot-content-conflict: cursor already has different content');
    return { captured: false, trigger: null };
  }
  let anchor = null;
  if (stored !== null) {
    const usable = validateSnapshotUsability(stored, observedEvents, STATE_EVENT_SCHEMA_VERSION);
    if (!usable.ok) throw new Error('capture flow: ' + usable.reason);
    anchor = extractCaptureAnchor(stored.state);
    if (anchor === null) throw new Error('capture flow: stored snapshot has no capture anchor');
  }
  const due = evaluateCaptureDue({ events: observedEvents, policy, anchor });
  if (!due.due) return { captured: false, trigger: null };

  await store.markRetention(
    projectId,
    (anchor?.seq ?? 0) + 1,
    snapshot.seq,
    'archive_after_snapshot',
  );
  await store.saveSnapshot(projectId, snapshot);
  return { captured: true, trigger: due.trigger };
}
