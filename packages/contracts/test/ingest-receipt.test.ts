import { describe, expect, it } from 'vitest';
import { projectCommandMode, projectCommandSchema } from '../src/project-command.js';
import { parseIngestReceipt } from '../src/ingest.js';
function receipt() {
  return {
    contract_version: 1,
    accepted: [0],
    duplicate: [1],
    rejected: [{ index: 2, token: 'ingest/schema-violation' }],
    event_results: [
      { index: 0, outcome: 'accepted' },
      { index: 1, outcome: 'duplicate' },
      { index: 2, outcome: 'rejected', rejection: { index: 2, token: 'ingest/schema-violation' } },
    ],
    server_supported_contract_versions: [1],
    server_supported_event_schema_versions: [1],
  };
}
describe('authoritative batch receipts', () => {
  it('accepts one matching outcome per sent index', () => {
    expect(parseIngestReceipt(receipt(), 3).duplicate).toEqual([1]);
  });
  it.each([
    () => ({ ...receipt(), event_results: receipt().event_results.slice(0, 2) }),
    () => ({
      ...receipt(),
      event_results: [
        receipt().event_results[0],
        receipt().event_results[0],
        receipt().event_results[2],
      ],
    }),
    () => ({
      ...receipt(),
      event_results: [...receipt().event_results.slice(0, 2), { index: 3, outcome: 'accepted' }],
    }),
    () => ({ ...receipt(), accepted: [0, 1] }),
    () => ({
      ...receipt(),
      event_results: [...receipt().event_results.slice(0, 2), { index: 2, outcome: 'rejected' }],
    }),
    () => ({
      ...receipt(),
      event_results: [
        ...receipt().event_results.slice(0, 2),
        { index: 2, outcome: 'rejected', rejection: { index: 2, token: 'ingest/ledger-conflict' } },
      ],
    }),
    () => ({
      ...receipt(),
      event_results: [
        {
          index: 0,
          outcome: 'accepted',
          rejection: { index: 0, token: 'ingest/schema-violation' },
        },
        ...receipt().event_results.slice(1),
      ],
    }),
  ])('refuses an ambiguous, forged or incomplete receipt', (make) => {
    expect(() => parseIngestReceipt(make(), 3)).toThrow();
  });
});

it('publishes proposal and execution modes from the command schema authority', () => {
  for (const option of projectCommandSchema.options) {
    const type = option.shape.type.value;
    expect(projectCommandMode(type)).toBe(
      ['asset.propose', 'return.submit', 'hold.register', 'direction.propose'].includes(type)
        ? 'propose'
        : 'execute',
    );
  }
});

it('accepts consistent unordered receipts with multiple accepted indexes', () => {
  const response = {
    ...receipt(),
    accepted: [2, 0, 1],
    duplicate: [],
    rejected: [],
    event_results: [
      { index: 2, outcome: 'accepted' },
      { index: 0, outcome: 'accepted' },
      { index: 1, outcome: 'accepted' },
    ],
  };
  expect(parseIngestReceipt(response, 3).accepted).toEqual([2, 0, 1]);
});
it('rejects blank command reasons at the public boundary', () => {
  expect(
    projectCommandSchema.safeParse({
      type: 'work.create',
      title: 'work',
      reason: ' ',
      expected_version: 0,
    }).success,
  ).toBe(false);
});
