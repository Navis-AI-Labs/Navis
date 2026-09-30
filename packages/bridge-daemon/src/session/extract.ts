import { createHash, randomUUID } from 'node:crypto';

import type { OutboxCaptureInput } from '../outbox/ports.js';

/**
 * Session-internal event extraction (spec: session-internal events are
 * extracted with content protected by default). Raw session steps become
 * Canonical Work Events — user.message / agent.message /
 * tool.call.requested / tool.call.result — carrying causation_id to link
 * each event to its predecessor so session order is replayable.
 *
 * Default `metadata` privacy class: only lengths, sha256 hashes, and a
 * bounded (≤120 char) summary are placed in `event_json`; bodies, tool
 * parameters, and tool results never leave the machine. Local-only events
 * take the same shape but are parked terminal by the outbox (seq stays null).
 */

export interface RawUserMessage {
  readonly kind: 'user.message';
  readonly body: string;
}

export interface RawAgentMessage {
  readonly kind: 'agent.message';
  readonly body: string;
}

export interface RawToolCallRequested {
  readonly kind: 'tool.call.requested';
  readonly tool: string;
  readonly parameters: unknown;
}

export interface RawToolCallResult {
  readonly kind: 'tool.call.result';
  readonly tool: string;
  readonly result: unknown;
}

export type RawSessionStep =
  RawUserMessage | RawAgentMessage | RawToolCallRequested | RawToolCallResult;

export interface ExtractOptions {
  readonly deviceId: string;
  readonly projectId: string;
  readonly privacyClass: 'metadata' | 'local-only';
  readonly newEventId?: () => string;
}

const SUMMARY_CAP = 120;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Bounded summary: a shape descriptor only — character/word-count and the
 * language hint, never raw content. The text body lives solely in the
 * sha256 hash, so a leak of the original body through the summary is
 * structurally impossible.
 */
function boundedSummary(input: string): string {
  const segments = input.split(/\s+/).filter((part) => part.length > 0);
  const base = `chars:${String(input.length)};words:${String(segments.length)}`;
  if (base.length <= SUMMARY_CAP) return base;
  /* v8 ignore next 1 -- char/word counts are always short; the cap is a belt */
  return base.slice(0, SUMMARY_CAP);
}

function serialisePayload(value: unknown): string {
  if (typeof value === 'string') return value;
  // stringify's signature advertises string always — cast through unknown so
  // we can guard the undefined case (functions, bare undefined) without the
  // type system claiming the guard is unnecessary.
  const text = JSON.stringify(value) as string | undefined;
  return text ?? '';
}

interface ProtectedContent {
  readonly sha256: string;
  readonly length: number;
  readonly summary: string;
}

function protect(content: string): ProtectedContent {
  return {
    sha256: sha256Hex(content),
    length: content.length,
    summary: boundedSummary(content),
  };
}

function stepContent(step: RawSessionStep): ProtectedContent & { readonly tool?: string } {
  switch (step.kind) {
    case 'user.message':
    case 'agent.message':
      return protect(step.body);
    case 'tool.call.requested':
    case 'tool.call.result': {
      const payload =
        step.kind === 'tool.call.requested'
          ? serialisePayload(step.parameters)
          : serialisePayload(step.result);
      return { ...protect(payload), tool: step.tool };
    }
    /* v8 ignore next 1 -- exhaustive switch; TS narrows all four kinds above */
    default:
      throw new Error('unreachable session step');
  }
}

/**
 * Extract raw session steps into causation-linked outbox captures.
 * Each step's event_id is generated; step N's causation_id is step N-1's
 * event_id; the first step carries no causation (chain root).
 */
export function extractSessionEvents(
  steps: readonly RawSessionStep[],
  options: ExtractOptions,
): OutboxCaptureInput[] {
  const newEventId = options.newEventId ?? randomUUID;
  const eventIds = steps.map(() => newEventId());
  return steps.map((step, index) => {
    const content = stepContent(step);
    const event = {
      type: step.kind,
      data: {
        sha256: content.sha256,
        length: content.length,
        summary: content.summary,
        ...(content.tool !== undefined ? { tool: content.tool } : {}),
      },
    };
    const capture: OutboxCaptureInput = {
      event_id: eventIds[index] ?? '00000000-0000-7000-8000-000000000000',
      device_id: options.deviceId,
      project_id: options.projectId,
      event_type: step.kind,
      event_json: JSON.stringify(event),
      privacy_class: options.privacyClass,
      ...(index > 0 ? { causation_id: eventIds[index - 1] } : {}),
    };
    return capture;
  });
}
