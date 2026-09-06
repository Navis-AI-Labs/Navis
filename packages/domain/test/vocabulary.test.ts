import { describe, expect, it } from 'vitest';

import { interfaceDefinitions } from '../src/schema/capability-interfaces.js';
import { linkTypeDefinitions } from '../src/schema/link-types.js';
import { validateVocabulary } from '../src/schema/vocabulary.js';

describe('vocabulary data definitions', () => {
  it('defines exactly the six link types of the vocabulary scope', () => {
    expect(linkTypeDefinitions.map((l) => l.name)).toEqual([
      'depends_on',
      'implemented_by',
      'contains_clause',
      'blocks_delivery',
      'derived_from',
      'refines',
    ]);
  });

  it('every link type names endpoints, cardinality, and a semantic description', () => {
    for (const link of linkTypeDefinitions) {
      expect(link.from_type.length).toBeGreaterThan(0);
      expect(link.to_type.length).toBeGreaterThan(0);
      expect(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']).toContain(
        link.cardinality,
      );
      expect(link.description.length).toBeGreaterThan(0);
    }
  });

  it('blocks_delivery names Hold and Delivery', () => {
    const link = linkTypeDefinitions.find((l) => l.name === 'blocks_delivery');
    expect(link?.from_type).toBe('Hold');
    expect(link?.to_type).toBe('Delivery');
  });

  it('refines reads in both directions through its reverse name', () => {
    const link = linkTypeDefinitions.find((l) => l.name === 'refines');
    expect(link?.reverse_name).toBe('refined_by');
  });

  it('Assetable declares the shared carrier shape with derived_from and refines constraints', () => {
    const assetable = interfaceDefinitions.find((i) => i.name === 'Assetable');
    expect(assetable?.properties.map((p) => p.name)).toEqual([
      'id',
      'scope',
      'provenance',
      'lifecycle',
      'content',
      'created_at',
    ]);
    expect(assetable?.link_type_constraints.map((c) => c.name)).toEqual([
      'derived_from',
      'refines',
    ]);
  });

  it('Deliverable carries the acceptance-linked properties and the acceptance-record constraint', () => {
    const deliverable = interfaceDefinitions.find((i) => i.name === 'Deliverable');
    expect(deliverable?.properties.map((p) => p.name)).toEqual([
      'accepted_at',
      'accepted_by',
      'delivered_at',
    ]);
    expect(deliverable?.link_type_constraints.map((c) => c.name)).toEqual(['accepted_by_record']);
  });

  it('the baseline vocabulary is internally consistent', () => {
    expect(validateVocabulary(linkTypeDefinitions, interfaceDefinitions)).toEqual([]);
  });

  it('a constraint matching no link type stands interface-scoped with a resolvable target', () => {
    const withoutAcceptanceRecord = linkTypeDefinitions.filter(
      (l) => !(l.name as string).includes('record'),
    );
    const issues = validateVocabulary([...withoutAcceptanceRecord], interfaceDefinitions);
    expect(issues).toEqual([]);
  });

  it('a constraint whose cardinality disagrees with its global link type is an issue', () => {
    const issues = validateVocabulary(linkTypeDefinitions, [
      {
        name: 'Assetable',
        description: 'test',
        properties: [],
        link_type_constraints: [
          { name: 'derived_from', target: 'Assetable', cardinality: 'one_to_one' },
        ],
      },
    ]);
    expect(issues).toEqual([
      { kind: 'constraint-cardinality', source: 'interface:Assetable', reference: 'derived_from' },
    ]);
  });

  it('a constraint target that resolves to no interface is an issue', () => {
    const issues = validateVocabulary(linkTypeDefinitions, [
      {
        name: 'Testable',
        description: 'test',
        properties: [],
        link_type_constraints: [
          { name: 'accepted_by_record', target: 'NoSuchInterface', cardinality: 'one_to_one' },
        ],
      },
    ]);
    expect(issues).toEqual([
      { kind: 'constraint-target', source: 'interface:Testable', reference: 'NoSuchInterface' },
    ]);
  });

  it('link type endpoints must resolve to registered core types', () => {
    const issues = validateVocabulary([{ ...linkTypeDefinitions[0], to_type: 'Feature' }], []);
    expect(issues).toEqual([{ kind: 'endpoint', source: 'link:depends_on', reference: 'Feature' }]);
  });

  it('template references are validated against the same rules', () => {
    const issues = validateVocabulary(
      linkTypeDefinitions,
      interfaceDefinitions,
      ['depends_on', 'no_such_link'],
      ['Assetable', 'NoSuchInterface'],
    );
    expect(issues).toEqual([
      { kind: 'relation-reference', source: 'template', reference: 'no_such_link' },
      { kind: 'implements-reference', source: 'template', reference: 'NoSuchInterface' },
    ]);
  });
});
