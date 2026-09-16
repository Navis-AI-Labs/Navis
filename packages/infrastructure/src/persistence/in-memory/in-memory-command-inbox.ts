import { inboxErrors } from '@navis/domain';
import type { BeginResult, CommandInbox, CommandOutcome } from '@navis/domain';

/**
 * In-memory CommandInbox: the semantic definition of the port. Claims are
 * keyed per project; a row stays in-flight until complete installs the
 * terminal outcome. All begin decisions go through the same three-way
 * classification the Postgres adapter enforces with the UNIQUE constraint.
 */
export class InMemoryCommandInbox implements CommandInbox {
  private readonly claims = new Map<
    string,
    { commandType: string; payloadHash: string; outcome?: CommandOutcome }
  >();

  async begin(
    projectId: string,
    key: string,
    commandType: string,
    payloadHash: string,
  ): Promise<BeginResult> {
    // Promise.resolve keeps the async port contract under the require-await rule
    await Promise.resolve();
    const compositeKey = `${projectId}:${key}`;
    const row = this.claims.get(compositeKey);
    if (row === undefined) {
      this.claims.set(compositeKey, { commandType, payloadHash });
      return { status: 'fresh' };
    }
    if (row.payloadHash !== payloadHash || row.commandType !== commandType)
      throw inboxErrors.collision();
    if (row.outcome === undefined) return { status: 'processing' };
    return { status: 'replay', outcome: row.outcome };
  }

  async complete(projectId: string, key: string, outcome: CommandOutcome): Promise<void> {
    await Promise.resolve();
    const compositeKey = `${projectId}:${key}`;
    const row = this.claims.get(compositeKey);
    if (row === undefined) throw inboxErrors.unknownKey();
    // Re-completing silently would erase the first result; one claim, one outcome.
    if (row.outcome !== undefined) throw inboxErrors.collision();
    row.outcome = outcome;
  }
}
