import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStateKernel, uuidv7 } from '@navis/domain';
import { parseIngestReceipt } from '@navis/contracts';
import { NavisClient, RemoteError } from '../src/remote/client.js';
import { IngestSender } from '../src/remote/ingest-sender.js';
import { extractSessionEvents } from '../src/session/extract.js';
import type { OutboxEvent } from '../src/outbox/ports.js';

afterEach(() => vi.restoreAllMocks());

function event(projectId: string, deviceId: string): OutboxEvent {
  const capture = extractSessionEvents([{ kind: 'user.message', body: 'private' }], {
    projectId,
    deviceId,
    privacyClass: 'metadata',
    occurredAt: '2026-10-10T00:00:00.000Z',
  })[0];
  if (capture === undefined) throw new Error('capture missing');
  return {
    ...capture,
    state: 'sending',
    seq: 1,
    causation_id: null,
    captured_at: '2026-10-10T00:00:00.000Z',
    normalized_at: undefined,
    sending_at: undefined,
    acked_at: undefined,
    keep_reason: null,
    retry_count: 0,
    retry_after: null,
    payload_hash: null,
  };
}
function snapshot(projectId: string, privacy = 'metadata') {
  return {
    project_id: projectId,
    state_version: 0,
    ledger_seq: 0,
    privacy_class: privacy,
    capabilities: { allowed_proposals: [], allowed_executions: [] },
    projection: new ProjectStateKernel().projection,
  };
}
it('keeps group-local receipt indexes correlated with the original mixed batch', async () => {
  const first = uuidv7();
  const second = uuidv7();
  const device = uuidv7();
  const client = new NavisClient('http://127.0.0.1:8080', '/unused');
  const request = vi.spyOn(client, 'request');
  request
    .mockResolvedValueOnce(snapshot(first))
    .mockResolvedValueOnce({
      contract_version: 1,
      accepted: [0],
      duplicate: [],
      rejected: [{ index: 1, token: 'ingest/authorization-denied' }],
      event_results: [
        { index: 0, outcome: 'accepted' },
        {
          index: 1,
          outcome: 'rejected',
          rejection: { index: 1, token: 'ingest/authorization-denied' },
        },
      ],
      server_supported_contract_versions: [1],
      server_supported_event_schema_versions: [1],
    })
    .mockResolvedValueOnce(snapshot(second, 'local-only'));
  const response = await new IngestSender(client).send([
    event(first, device),
    event(second, device),
    event(first, device),
  ]);
  const envelope = JSON.parse(response.body) as { data: unknown };
  const receipt = parseIngestReceipt(envelope.data, 3);
  expect(receipt.accepted).toEqual([0]);
  expect(receipt.rejected.map((value) => value.index)).toEqual([2, 1]);
  expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  expect(JSON.stringify(request.mock.calls)).not.toContain('private');
});
it('preserves transient retry deadlines and refuses invalid receipt shapes', async () => {
  const client = new NavisClient('http://127.0.0.1:8080', '/unused');
  const project = uuidv7();
  const request = vi.spyOn(client, 'request');
  const until = '2026-10-10T00:01:00.000Z';
  request.mockRejectedValueOnce(new RemoteError(429, 'limited', until));
  expect(await new IngestSender(client).send([event(project, uuidv7())])).toEqual({
    status: 429,
    body: '',
    retryAfter: until,
  });
  request.mockResolvedValueOnce(snapshot(project)).mockResolvedValueOnce({ accepted: [0] });
  await expect(new IngestSender(client).send([event(project, uuidv7())])).rejects.toThrow();
  request.mockResolvedValueOnce(snapshot(project)).mockResolvedValueOnce({
    contract_version: 1,
    accepted: [],
    rejected: [],
    duplicate: [0],
    event_results: [{ index: 0, outcome: 'duplicate' }],
    server_supported_contract_versions: [1],
    server_supported_event_schema_versions: [1],
  });
  const duplicate = await new IngestSender(client).send([event(project, uuidv7())]);
  expect(JSON.parse(duplicate.body)).toMatchObject({ data: { duplicate: [0], accepted: [] } });
});
