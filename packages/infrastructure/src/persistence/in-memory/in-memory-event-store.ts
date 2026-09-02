import { deepFreeze } from '@navis/domain';
import type { EventEnvelope, EventStore, ProjectionSnapshot } from '@navis/domain';

/**
 * In-memory EventStore: same port, no database — behavior tests run
 * without any database. Map keys are `projectId` to keep per-project
 * head seq isolated.
 */
export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, EventEnvelope[]>();
  private readonly snapshots = new Map<string, Map<number, ProjectionSnapshot>>();

  async append(
    projectId: string,
    events: readonly EventEnvelope[],
    expectedSeq: number,
  ): Promise<void> {
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
    events.forEach((e, i) => {
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
    });
    // Store an owned, deep-frozen copy of each event: the Postgres adapter
    // serializes rows it exclusively owns behind the INSERT-only trigger, so
    // a later caller-side mutation of the envelope must not leak into the
    // stream here either (adapter parity for the immutability contract).
    for (const e of events) stream.push(deepFreeze(structuredClone(e)));
    this.streams.set(projectId, stream);
  }

  async loadEvents(projectId: string, fromSeq: number): Promise<readonly EventEnvelope[]> {
    const cursor = Math.max(0, Math.floor(fromSeq)); // matches the Postgres adapter's cursor normalization
    const stream: EventEnvelope[] = this.streams.get(projectId) ?? [];
    return await Promise.resolve(stream.filter((e) => e.seq >= cursor));
  }

  async saveSnapshot(projectId: string, snapshot: ProjectionSnapshot): Promise<void> {
    await Promise.resolve();
    // A snapshot pins a replay point: the caller vouches that `state` can
    // resume the projection at `seq`. A state without a numeric seq cursor
    // would silently degrade every later load, so both adapters reject it
    // at write time (Postgres additionally checks on load for legacy rows).
    const seq = snapshot.state['seq'];
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      throw new Error('snapshot state is missing the required seq cursor');
    }
    // Multi-version storage mirroring project_snapshots(version PK): the
    // highest state_version wins on load, and re-saving an existing version
    // is a no-op — exactly the adapter's ON CONFLICT DO NOTHING.
    const versions = this.snapshots.get(projectId) ?? new Map<number, ProjectionSnapshot>();
    if (!versions.has(snapshot.state_version)) {
      versions.set(snapshot.state_version, deepFreeze(structuredClone(snapshot)));
    }
    this.snapshots.set(projectId, versions);
  }

  async loadSnapshot(projectId: string): Promise<ProjectionSnapshot | null> {
    await Promise.resolve();
    const versions = this.snapshots.get(projectId);
    if (versions === undefined) return null;
    let latest: ProjectionSnapshot | null = null;
    for (const [v, snapshot] of versions) {
      if (latest === null || v > latest.state_version) latest = snapshot;
    }
    return latest;
  }
}
