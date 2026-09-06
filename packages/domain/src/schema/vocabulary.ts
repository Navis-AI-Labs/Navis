/**
 * Type vocabulary — the data layer for schema-registry-foundation.
 *
 * Type definitions here are data, not code (the composition model: domain
 * types commit to capability shapes through interfaces, consume relations
 * through link types, and never inherit implementation). Definitions carry
 * shape and semantics only; enforcement behavior lives where the kernel
 * already owns it (e.g. the blocking-hold delivery gate enforces what the
 * blocks_delivery declaration names).
 */

/**
 * Core object type names — the single literal source for the registry and
 * the integrity rules. The list is add-only: names are appended by an
 * accepted specification change, never removed or renamed.
 */
export const coreObjectTypeNames = [
  'Project',
  'Work',
  'TaskSpace',
  'Asset',
  'Acceptance',
  'Delivery',
  'WorkRun',
  'Hold',
] as const;

export type CoreObjectTypeName = (typeof coreObjectTypeNames)[number];

/**
 * Minimal descriptor of a registered object type. The kind value set equals
 * what the registry registers today; widening it (domain types) rides the
 * accepted change that registers them.
 */
export interface ObjectTypeDescriptor {
  readonly name: string;
  readonly kind: 'core';
}

/**
 * Cardinality of a link type: how many targets one source may link, and
 * whether the link reads in both directions through a reverse name.
 */
export type LinkCardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

/** A named relation between two object types, declared as data. */
export interface LinkTypeDefinition {
  readonly name: string;
  readonly from_type: string;
  readonly to_type: string;
  readonly cardinality: LinkCardinality;
  readonly description: string;
  readonly reverse_name?: string;
}

/** Property declaration inside an interface or a template object type. */
export interface PropertyDeclaration {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
}

/** A link type constraint declared by an interface. */
export interface LinkTypeConstraint {
  readonly name: string;
  readonly target: string;
  readonly cardinality: LinkCardinality;
  readonly description?: string;
}

/** Shared capability shape that object types commit to via implements. */
export interface InterfaceDefinition {
  readonly name: string;
  readonly description: string;
  readonly properties: readonly PropertyDeclaration[];
  readonly link_type_constraints: readonly LinkTypeConstraint[];
}

export interface VocabularyIssue {
  readonly kind:
    | 'constraint-cardinality'
    | 'constraint-target'
    | 'endpoint'
    | 'relation-reference'
    | 'implements-reference';
  readonly source: string;
  readonly reference: string;
}

export function validateVocabulary(
  linkTypes: readonly LinkTypeDefinition[],
  interfaces: readonly InterfaceDefinition[],
  templateRelations: readonly string[] = [],
  templateImplements: readonly string[] = [],
): readonly VocabularyIssue[] {
  const issues: VocabularyIssue[] = [];
  const linkTypeNames = new Set(linkTypes.map((l) => l.name));
  const registeredNames = new Set<string>(coreObjectTypeNames);

  const interfaceNames = new Set(interfaces.map((i) => i.name));
  for (const iface of interfaces) {
    for (const constraint of iface.link_type_constraints) {
      const linkType = linkTypes.find((l) => l.name === constraint.name);
      if (linkType === undefined) {
        // interface-scoped constraint (no global relation): it stands on the
        // interface as a requirement declaration, and its target resolves in
        // either namespace — a defined interface (Assetable) or a registered
        // core type (the acceptance-record constraint targets Acceptance)
        if (!interfaceNames.has(constraint.target) && !registeredNames.has(constraint.target)) {
          issues.push({
            kind: 'constraint-target',
            source: `interface:${iface.name}`,
            reference: constraint.target,
          });
        }
        continue;
      }
      if (linkType.cardinality !== constraint.cardinality) {
        issues.push({
          kind: 'constraint-cardinality',
          source: `interface:${iface.name}`,
          reference: constraint.name,
        });
      }
    }
  }

  for (const link of linkTypes) {
    for (const endpoint of [link.from_type, link.to_type]) {
      if (!registeredNames.has(endpoint)) {
        issues.push({ kind: 'endpoint', source: `link:${link.name}`, reference: endpoint });
      }
    }
  }

  for (const relation of templateRelations) {
    if (!linkTypeNames.has(relation)) {
      issues.push({ kind: 'relation-reference', source: 'template', reference: relation });
    }
  }

  for (const iface of templateImplements) {
    if (!interfaces.some((i) => i.name === iface)) {
      issues.push({ kind: 'implements-reference', source: 'template', reference: iface });
    }
  }

  return issues;
}
