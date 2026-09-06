import { describe, expect, expectTypeOf, it } from 'vitest';

import { typeRegistry } from '../src/registry/type-registry.js';
import { coreObjectTypeNames } from '../src/schema/vocabulary.js';
import type { ObjectTypeDescriptor } from '../src/schema/vocabulary.js';

const coreTypeSchemaExports = [
  'Project',
  'Work',
  'TaskSpace',
  'Asset',
  'Acceptance',
  'Delivery',
  'WorkRun',
  'Hold',
] as const;

describe('type registry', () => {
  it('lists exactly the eight core object types with their kind', () => {
    const listing = typeRegistry.list();
    expect(listing.map((d) => d.name)).toEqual([...coreObjectTypeNames]);
    expect(listing).toHaveLength(8);
  });

  it('lookup by name returns the descriptor', () => {
    const hold = typeRegistry.lookup('Hold');
    expect(hold.name).toBe('Hold');
    expect(hold.kind).toBe('core');
  });

  it('lookup of an unknown name fails explicitly naming the request', () => {
    expect(() => typeRegistry.lookup('Feature')).toThrow('type not registered: Feature');
  });

  it('repeated listings are identical', () => {
    expect(typeRegistry.list()).toEqual(typeRegistry.list());
  });

  it('registry names stay pinned to the schema module exports', () => {
    expect(coreObjectTypeNames).toEqual(coreTypeSchemaExports);
  });

  it('returned descriptors are frozen and cannot alter the registry', () => {
    const hold = typeRegistry.lookup('Hold');
    expectTypeOf(hold).toExtend<ObjectTypeDescriptor>();
    expect(Object.isFrozen(hold)).toBe(true);
  });

  it('the listing cannot be used to mutate the registry', () => {
    const listing = typeRegistry.list();
    expect(Object.isFrozen(listing)).toBe(true);
    expect(() =>
      (listing as unknown as ObjectTypeDescriptor[]).push({ name: 'X', kind: 'core' }),
    ).toThrow();
    expect(typeRegistry.list()).toHaveLength(8);
  });
});
