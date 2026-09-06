/**
 * Link type definitions — the six named relations of the core vocabulary,
 * declared as data. Endpoints name registered core types; `refines` reads in
 * both directions through its reverse name. The enforcement behavior of a
 * relation lives where the kernel owns it (blocks_delivery is enforced by
 * the delivery gate, not here); the declaration exists so vocabulary and
 * behavior can be pinned together by reconciliation tests.
 *
 * Endpoint choices: the core layer registers only core object types, so a
 * core link type cannot name a domain type that does not exist yet. Where a
 * relation is inherently domain-shaped, its core entry carries the nearest
 * core pair instead: depends_on anchors the Work.depends_on field (Work refs
 * Work), implemented_by and contains_clause generalize to Work→Asset and
 * Asset→Asset. blocks_delivery, derived_from, and refines are core pairs as
 * declared. Project vocabularies introduce domain-typed relations by
 * declaring their own link type definitions in the same shape.
 */

import type { LinkTypeDefinition } from './vocabulary.js';

export const linkTypeDefinitions = [
  {
    name: 'depends_on',
    from_type: 'Work',
    to_type: 'Work',
    cardinality: 'many_to_many',
    description: 'A work item depends on the completion or state of another work item.',
  },
  {
    name: 'implemented_by',
    from_type: 'Work',
    to_type: 'Asset',
    cardinality: 'one_to_many',
    description: 'The assets that realize a work item.',
  },
  {
    name: 'contains_clause',
    from_type: 'Asset',
    to_type: 'Asset',
    cardinality: 'one_to_many',
    description: 'A composite asset contains its constituent clause assets.',
  },
  {
    name: 'blocks_delivery',
    from_type: 'Hold',
    to_type: 'Delivery',
    cardinality: 'many_to_one',
    description:
      'An active blocking hold on an asset refuses delivery of that asset; enforcement lives in the delivery gate.',
  },
  {
    name: 'derived_from',
    from_type: 'Asset',
    to_type: 'Asset',
    cardinality: 'many_to_many',
    description: 'Provenance tracing: an asset originates from another asset.',
  },
  {
    name: 'refines',
    from_type: 'Asset',
    to_type: 'Asset',
    cardinality: 'many_to_many',
    description:
      'Quality refinement: an asset is a more precise or more complete version of another asset. Unlike derived_from (origin), refinement expresses a quality difference; both may coexist on the same pair. The behavioral quality-differential effect is not part of the core vocabulary.',
    reverse_name: 'refined_by',
  },
] as const satisfies readonly LinkTypeDefinition[];
