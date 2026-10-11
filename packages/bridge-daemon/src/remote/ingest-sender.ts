import { createHash } from 'node:crypto';
import { canonicalJson } from '@navis/domain';
import {
  canonicalWorkEventStrictSchema,
  projectSnapshotSchema,
  type ingestResponseSchema,
  parseIngestReceipt,
} from '@navis/contracts';
import type { OutboxEvent } from '../outbox/ports.js';
import type { HttpResponseLike, HttpSenderLike } from '../outbox/upload-loop.js';
import { type NavisClient, RemoteError } from './client.js';

/** Batch indexes are remapped only after each actual service receipt has been validated. */
export class IngestSender implements HttpSenderLike {
  constructor(private readonly client: NavisClient) {}
  async send(batch: readonly OutboxEvent[]): Promise<HttpResponseLike> {
    const groups = new Map<
      string,
      { projectId: string; deviceId: string; entries: { event: OutboxEvent; index: number }[] }
    >();
    batch.forEach((event, index) => {
      const group = `${event.device_id}:${event.project_id}`;
      const rows = groups.get(group) ?? {
        projectId: event.project_id,
        deviceId: event.device_id,
        entries: [],
      };
      rows.entries.push({ event, index });
      groups.set(group, rows);
    });
    const combined = {
      contract_version: 1 as const,
      accepted: [] as number[],
      rejected: [] as ReturnType<typeof ingestResponseSchema.parse>['rejected'],
      duplicate: [] as number[],
      event_results: [] as ReturnType<typeof ingestResponseSchema.parse>['event_results'],
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
    };
    try {
      for (const { projectId, deviceId, entries } of groups.values()) {
        const state = projectSnapshotSchema.parse(
          await this.client.request('GET', `/api/projects/${projectId}/snapshot`),
        );
        if (state.privacy_class === 'local-only') {
          for (const { index } of entries) {
            const rejection = { index, token: 'ingest/authorization-denied' as const };
            combined.rejected.push(rejection);
            combined.event_results.push({ index, outcome: 'rejected', rejection });
          }
          continue;
        }
        const events = entries.map(({ event }) => {
          const canonical = canonicalWorkEventStrictSchema.parse(JSON.parse(event.event_json));
          return {
            event_id: event.event_id,
            ...(event.causation_id == null ? {} : { causation_id: event.causation_id }),
            event: canonical,
            payload_hash: {
              algorithm: 'sha256',
              value: createHash('sha256').update(canonicalJson(canonical)).digest('hex'),
            },
          };
        });
        const response = parseIngestReceipt(
          await this.client.request('POST', '/api/ingest', {
            contract_version: 1,
            event_schema_version: 1,
            device_id: deviceId,
            events,
          }),
          entries.length,
        );
        for (const result of response.event_results) {
          const mapped = entries[result.index];
          /* v8 ignore next 1 -- receipt validation above proves every result index belongs to this group */
          if (mapped === undefined) throw new Error('receipt index outside batch');
          const index = mapped.index;
          if (result.outcome === 'accepted') combined.accepted.push(index);
          else if (result.outcome === 'duplicate') combined.duplicate.push(index);
          else {
            combined.rejected.push({ ...result.rejection, index });
          }
          combined.event_results.push(
            result.outcome === 'rejected'
              ? { index, outcome: 'rejected', rejection: { ...result.rejection, index } }
              : { index, outcome: result.outcome },
          );
        }
      }
    } catch (error) {
      if (error instanceof RemoteError)
        return {
          status: error.status,
          body: '',
          ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
        };
      throw error;
    }
    return { status: 200, body: JSON.stringify({ data: combined }) };
  }
}
