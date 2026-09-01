/**
 * schema-module error registry — closed, add-only kebab-case tokens
 * resolving to stable `schema/<token>` URNs.
 *
 * Renaming, removing, or reusing a token is a breaking change.
 */

export interface SchemaError {
  readonly module: 'schema';
  readonly code: string;
  readonly urn: string;
  readonly details?: Record<string, unknown>;
}

/** The single token→URN source of truth; factories and exhaustiveness tests both read from here. */
export const schemaErrorTokens = {
  'illegal-transition': 'schema/illegal-transition',
  'not-enabled': 'schema/not-enabled',
  'purge-conditions-unmet': 'schema/purge-conditions-unmet',
} as const;

export type SchemaErrorToken = keyof typeof schemaErrorTokens;

function schemaError(code: SchemaErrorToken, details: Record<string, unknown>): SchemaError {
  return { module: 'schema', code, urn: schemaErrorTokens[code], details };
}

export const schemaErrors = {
  illegalTransition: (from: string, to: string): SchemaError =>
    schemaError('illegal-transition', { from, to }),
  notEnabled: (value: string): SchemaError => schemaError('not-enabled', { value }),
  purgeConditionsUnmet: (
    daysArchived: number,
    doubleConfirmation: boolean,
    thresholdDays: number,
  ): SchemaError =>
    schemaError('purge-conditions-unmet', {
      days_archived: daysArchived,
      double_confirmation: doubleConfirmation,
      threshold_days: thresholdDays,
    }),
} as const;
