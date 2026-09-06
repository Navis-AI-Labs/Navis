/**
 * Type registry — the read-only authority on which object types exist.
 * Registers the eight core object types at module initialization as frozen
 * minimal descriptors and exposes lookup-by-name and complete listing.
 * Closure is structural: the module exports a populated registry, not a
 * mutator, so no consumer path can add, remove, or rename an entry.
 */

import { coreObjectTypeNames } from '../schema/vocabulary.js';
import type { ObjectTypeDescriptor } from '../schema/vocabulary.js';

const coreDescriptors: readonly ObjectTypeDescriptor[] = Object.freeze(
  coreObjectTypeNames.map((name): ObjectTypeDescriptor => ({ name, kind: 'core' })),
);

const lookupTable: ReadonlyMap<string, ObjectTypeDescriptor> = new Map(
  coreDescriptors.map((d) => [d.name, Object.freeze(d)]),
);

/** The registered core object types, in stable listing order. */
export const typeRegistry = {
  lookup(name: string): ObjectTypeDescriptor {
    const descriptor = lookupTable.get(name);
    if (descriptor === undefined) {
      throw new Error(`type not registered: ${name}`);
    }
    return descriptor;
  },

  list(): readonly ObjectTypeDescriptor[] {
    return coreDescriptors;
  },
};
