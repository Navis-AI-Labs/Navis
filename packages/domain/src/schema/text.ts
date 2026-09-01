import { z } from 'zod';

/**
 * Free-form multi-line text (descriptions, rationales, feedback) — the shared
 * text constraint used across 6+ models.
 */
export const textSchema = z.string().min(1).max(65_536);
