import { z } from 'zod';

import { textSchema } from './text.js';
import { instantSchema } from './time.js';
import { uuidSchema } from './ids.js';

/** Delivery — an accepted asset reaching a real-world target; retries are new attempts, not rewrites. */

export const deliveryTargetTypeSchema = z
  .enum(['staging', 'production', 'customer_confirmation', 'business_process', 'external_system'])
  .meta({ description: 'Delivery tier (baseline five-value enum).', id: 'DeliveryTargetType' });

export const deliveryConfirmationStatusSchema = z
  .enum(['delivered', 'confirmed', 'rejected', 'pending'])
  .meta({
    description:
      'Delivery arrival status: delivered=sent out, confirmed=the business side acknowledges receipt, rejected=the business side refuses, pending=awaiting confirmation.',
    id: 'DeliveryConfirmationStatus',
  });

export const deliverySchema = z
  .strictObject({
    id: uuidSchema,
    deleted_at: instantSchema.nullable().optional(),
    // event-derived read cache; writable only by the projection replay path
    updated_at: instantSchema.nullable().optional(),
    updated_by: uuidSchema.nullable().optional(),
    created_at: instantSchema,
    asset_id: uuidSchema, // ref Asset
    // typed ref: internal object id or external URI
    target_ref: z.string().min(1).max(512),
    target_type: deliveryTargetTypeSchema,
    dispatched_at: instantSchema, // the send-out fact
    // physical version anchor: the delivered Asset's content.sha256
    version: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    // retry after rejection is a new attempt, not an in-place rewrite
    attempt_no: z.number().int().min(1).max(1000),
    confirmed_by: uuidSchema.optional(), // ref Participant
    confirmed_at: instantSchema.optional(),
    confirmation_status: deliveryConfirmationStatusSchema.default('delivered'),
    // real-world feedback that can re-enter the project as new work
    feedback: textSchema.optional(),
  })
  /** Confirmation facts exist only after the business side answered (confirmed/rejected). */
  .refine(
    (v) =>
      (v.confirmation_status !== 'confirmed' && v.confirmation_status !== 'rejected') ||
      (!!v.confirmed_by && !!v.confirmed_at),
    {
      path: ['confirmed_by'],
      error:
        'confirmed_by and confirmed_at are required once the business side confirmed or rejected',
    },
  )
  .meta({
    description: 'An accepted asset delivered to a customer, business process, or external system.',
    id: 'Delivery',
  });

export type Delivery = z.infer<typeof deliverySchema>;
export type DeliveryTargetType = z.infer<typeof deliveryTargetTypeSchema>;
export type DeliveryConfirmationStatus = z.infer<typeof deliveryConfirmationStatusSchema>;
