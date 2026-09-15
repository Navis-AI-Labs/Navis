import {
  canonicalEquals,
  eventEnvelopeSchema,
  eventRetentionClass,
  immutableCopy,
  projectionSnapshotSchema,
  retentionClassSchema,
} from '@navis/domain';
import type { EventEnvelope, EventStore, ProjectionSnapshot, RetentionClass } from '@navis/domain';

/**
 * In-memory EventStore: same port, no database — behavior tests run
 * without any database. Map keys are `projectId` to keep per-project
 * head seq isolated.
 */
export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, EventEnvelope[]>();
  private readonly snapshots = new Map<string, Map<number, ProjectionSnapshot>>();
  // key: `${projectId}:${seq}` — mirrors event_retention_marks semantics
  private readonly marks = new Map<string, RetentionClass>();
  private readonly eventIds = new Map<string, string>();

  async append(
    projectId: string,
    events: readonly EventEnvelope[],
    expectedSeq: number,
  ): Promise<void> {
    const owned = events.map((event) => immutableCopy(eventEnvelopeSchema.parse(event)));
    // Promise.resolve keeps the async port contract under the require-await rule
    await Promise.resolve();
    const stream: EventEnvelope[] = this.streams.get(projectId) ?? [];
    const last = stream[stream.length - 1];
    const head = last === undefined ? 0 : last.seq;
    if (head !== expectedSeq) {
      throw new Error(`version-conflict: expected ${String(expectedSeq)}, actual ${String(head)}`);
    }
    // Validate the whole batch before mutating anything: a failed append
    // must leave the stream exactly as it was (all-or-nothing, matching the
    // Postgres transaction).
    owned.forEach((e, i) => {
      if (e.seq !== head + i + 1) {
        throw new Error(
          `version-conflict: event seq ${String(e.seq)} does not continue head ${String(head)}`,
        );
      }
      if (e.project_id !== projectId) {
        throw new Error(
          `envelope-project-mismatch: event claims project ${e.project_id}, appending to ${projectId}`,
        );
      }
      const owner = this.eventIds.get(e.event_id);
      if (owner !== undefined || owned.slice(0, i).some((prior) => prior.event_id === e.event_id)) {
        throw new Error(`event-id-conflict: event ${e.event_id} already exists`);
      }
    });
    // Store an owned, deep-frozen copy of each event: the Postgres adapter
    // serializes rows it exclusively owns behind the INSERT-only trigger, so
    // a later caller-side mutation of the envelope must not leak into the
    // stream here either (adapter parity for the immutability contract).
    for (const e of owned) {
      stream.push(e);
      this.eventIds.set(e.event_id, projectId);
      if (eventRetentionClass(e.event_type) === 'permanent') {
        this.marks.set(`${projectId}:${String(e.seq)}`, 'permanent');
      }
    }
    this.streams.set(projectId, stream);
  }

  async loadEvents(projectId: string, fromSeq: number): Promise<readonly EventEnvelope[]> {
    const cursor = Math.max(0, Math.floor(fromSeq)); // matches the Postgres adapter's cursor normalization
    const stream: EventEnvelope[] = this.streams.get(projectId) ?? [];
    return await Promise.resolve(stream.filter((e) => e.seq >= cursor));
  }

  async saveSnapshot(projectId: string, snapshot: ProjectionSnapshot): Promise<void> {
    const owned = immutableCopy(projectionSnapshotSchema.parse(snapshot));
    await Promise.resolve();
    const event = this.streams.get(projectId)?.find((row) => row.seq === owned.seq);
    if (event?.state_version !== owned.state_version) {
      throw new Error('snapshot cursor is not committed at the supplied state version');
    }
    const versions = this.snapshots.get(projectId) ?? new Map<number, ProjectionSnapshot>();
    const existing = versions.get(owned.seq);
    if (existing !== undefined && !canonicalEquals(existing, owned)) {
      throw new Error('snapshot-content-conflict: cursor already has different content');
    }
    versions.set(owned.seq, owned);
    this.snapshots.set(projectId, versions);
  }

  async loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null> {
    await Promise.resolve();
    const versions = this.snapshots.get(projectId);
    if (versions === undefined) return null;
    let latest: ProjectionSnapshot | null = null;
    for (const [seq, snapshot] of versions) {
      if (latest === null || seq > latest.seq) latest = snapshot;
    }
    return latest;
  }

  async markRetention(
    projectId: string,
    fromSeq: number,
    toSeq: number,
    retentionClass: RetentionClass,
  ): Promise<readonly number[]> {
    retentionClassSchema.parse(retentionClass);
    if (!Number.isSafeInteger(Math.floor(fromSeq)) || !Number.isSafeInteger(Math.floor(toSeq))) {
      throw new Error('invalid retention sequence range');
    }
    await Promise.resolve();
    const lo = Math.max(1, Math.floor(fromSeq));
    const hi = Math.floor(toSeq);
    if (hi < lo) return [];
    // Scan existing rows, not every integer in an untrusted cursor range.
    // Existing classifications remain first-write-wins.
    const stream = this.streams.get(projectId) ?? [];
    const toMark = stream
      .filter(
        (event) =>
          event.seq >= lo &&
          event.seq <= hi &&
          !this.marks.has(`${projectId}:${String(event.seq)}`) &&
          (retentionClass === 'permanent' ||
            eventRetentionClass(event.event_type) === 'archive_after_snapshot'),
      )
      .map((event) => event.seq);
    for (const seq of toMark) this.marks.set(`${projectId}:${String(seq)}`, retentionClass);
    return toMark;
  }
}
