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

/** Maps the public ingest contract to the batch use case. The service composition authenticates and authorizes before this handler runs. */

export interface IngestRouteDeps {
  readonly canCapture?: (projectId: string) => Promise<boolean>;
  readonly participantId?: () => string | null;
  /** The ledger; a concrete adapter is injected by the composition root. */
  readonly eventStore: EventStore;
  /** Per-project switch for server-side payload verification. */
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

      const participantId = deps.participantId?.();
      const request: IngestBatchRequest = {
        ...(participantId == null ? {} : { participantId }),
        deviceId: parsed.device_id,
        events: parsed.events,
      };
      const batch = await ingestBatch(
        {
          eventStore: deps.eventStore,
          verifyPayloadHash: deps.verifyPayloadHash,
          now: deps.now,
          ...(deps.canCapture === undefined ? {} : { canCapture: deps.canCapture }),
        },
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
