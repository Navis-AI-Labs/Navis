/**
 * Core interface definitions — shared capability shapes declared as data.
 * Implementing an interface commits a type to the declared shape; it never
 * transfers values (composition, not inheritance). Property names align
 * with the domain schemas: the lifecycle property uses the implemented
 * Asset lifecycle enum's name; provenance is optional; content describes
 * the optional physical carrier.
 */

import type { InterfaceDefinition } from './vocabulary.js';

export const interfaceDefinitions = [
  {
    name: 'Assetable',
    description:
      'Shared shape of a referenceable content carrier: identity, scope, provenance, lifecycle, optional physical-carrier description, creation timestamp.',
    properties: [
      { name: 'id', type: 'uuid', required: true },
      {
        name: 'scope',
        type: 'enum',
        required: true,
        description: 'participant|session|task|project|organization',
      },
      { name: 'provenance', type: 'text', required: false },
      {
        name: 'lifecycle',
        type: 'enum',
        required: true,
        description: 'the implemented type\u2019s lifecycle enum',
      },
      {
        name: 'content',
        type: 'object',
        required: false,
        description: 'optional physical-carrier description',
      },
      { name: 'created_at', type: 'datetime', required: true },
    ],
    link_type_constraints: [
      {
        name: 'derived_from',
        target: 'Assetable',
        cardinality: 'many_to_many',
        description: 'Origin tracing to another content carrier.',
      },
      {
        name: 'refines',
        target: 'Assetable',
        cardinality: 'many_to_many',
        description: 'Quality refinement of another content carrier.',
      },
    ],
  },
  {
    name: 'Deliverable',
    description:
      'Shared shape of a deliverable carrier: acceptance timestamps and the required acceptance-record constraint — delivery demands a prior acceptance.',
    properties: [
      { name: 'accepted_at', type: 'datetime', required: false },
      { name: 'accepted_by', type: 'uuid', required: false },
      { name: 'delivered_at', type: 'datetime', required: false },
    ],
    link_type_constraints: [
      {
        name: 'accepted_by_record',
        target: 'Acceptance',
        cardinality: 'one_to_one',
        description: 'The acceptance record that authorizes delivery; required for a deliverable.',
      },
    ],
  },
] as const satisfies readonly InterfaceDefinition[];
