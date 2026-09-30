import {
  canonicalWorkEventSchemaVersion,
  encodeIngestResponse,
  ingestContractSchemaVersion,
  parseIngestRequest,
  UnsupportedIngestContractVersionError,
} from '@navis/contracts';
import { ingestBatch, type IngestBatchRequest } from '@navis/application';
import type { EventStore } from '@navis/domain';

import { UnsupportedContractVersionError } from '../platform/errors.js';
import type { ServiceRoute } from '../platform/server.js';

/**
 * `POST /api/ingest` — the batch upload surface (spec requirement: ingest
 * accepts event batches and deduplicates on (event_id, device_id)).
 *
 * The route owns transport only: it parses the request against the public
 * contract, hands the batch to the use case, and shapes the response. Per-event
 * outcomes, rejection tokens, and the ledger append all live in the use case;
 * authorization arrives with the request context and is enforced downstream of
 * this route by the membership middleware (spec: authentication establishes
 * device identity; authorization is membership). The envelope (`{data, meta}`)
 * is applied by the server core; the route returns the body.
 */

export interface IngestRouteDeps {
  /** The ledger; a concrete adapter is injected by the composition root. */
  readonly eventStore: EventStore;
  /** Per-project switch for server-side payload verification (G7). */
  readonly verifyPayloadHash: boolean;
  /** Receipt time for the ledger's `recorded_at`; the kernel never reads a clock. */
  readonly now: () => string;
}

export function ingestRoute(deps: IngestRouteDeps): ServiceRoute {
  return {
    method: 'POST',
    path: '/api/ingest',
    requiresBody: true,
    handle: async (input: unknown) => {
      let parsed;
      try {
        parsed = parseIngestRequest(input);
      } catch (error) {
        // An unsupported contract version is refused before any event is
        // interpreted, and the response names what the service supports.
        if (error instanceof UnsupportedIngestContractVersionError) {
          throw new UnsupportedContractVersionError(error.received, [ingestContractSchemaVersion]);
        }
        throw error;
      }

      const request: IngestBatchRequest = {
        deviceId: parsed.device_id,
        events: parsed.events,
      };
      const batch = await ingestBatch(
        { eventStore: deps.eventStore, verifyPayloadHash: deps.verifyPayloadHash, now: deps.now },
        request,
      );

      return encodeIngestResponse({
        contract_version: ingestContractSchemaVersion,
        accepted: [...batch.accepted],
        rejected: [...batch.rejected],
        duplicate: [...batch.duplicate],
        event_results: [...batch.event_results],
        server_supported_contract_versions: [ingestContractSchemaVersion],
        server_supported_event_schema_versions: [canonicalWorkEventSchemaVersion],
      });
    },
  };
}
