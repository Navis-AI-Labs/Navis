/**
 * Preset templates — starting vocabularies declared as data. A template
 * carries object type definitions, link type references, and interface
 * implementations only: no action types, no criteria references, no
 * commands. Template object type definitions are structurally identical to
 * what a future proposed domain type definition will look like — the
 * templates double as the shape exemplar of "type definitions are data".
 */

import type { LinkTypeDefinition, PropertyDeclaration } from '../vocabulary.js';

export interface TemplateObjectType {
  readonly name: string;
  readonly implements: readonly string[];
  readonly properties: readonly PropertyDeclaration[];
  readonly relations: readonly TemplateRelation[];
}

export interface TemplateRelation {
  readonly name: string;
  readonly target: string;
  readonly cardinality: LinkTypeDefinition['cardinality'];
}

export interface ProjectTemplate {
  readonly name: string;
  readonly description: string;
  readonly object_types: readonly TemplateObjectType[];
  readonly interfaces: readonly string[];
}

export const softwareProjectTemplate: ProjectTemplate = {
  name: 'software_project',
  description:
    'Starting vocabulary for a software project: features, pull requests, and their relations.',
  object_types: [
    {
      name: 'Feature',
      implements: ['Assetable'],
      properties: [
        { name: 'title', type: 'text', required: true },
        {
          name: 'status',
          type: 'enum',
          required: true,
          description: 'draft|in_review|accepted|delivered',
        },
        { name: 'priority', type: 'enum', required: true, description: 'p0|p1|p2|p3' },
      ],
      relations: [
        { name: 'depends_on', target: 'Feature', cardinality: 'many_to_many' },
        { name: 'implemented_by', target: 'PullRequest', cardinality: 'one_to_many' },
      ],
    },
    {
      name: 'PullRequest',
      implements: ['Assetable'],
      properties: [
        { name: 'url', type: 'text', required: false },
        { name: 'status', type: 'enum', required: true, description: 'open|merged|closed' },
      ],
      relations: [],
    },
  ],
  interfaces: ['Assetable'],
};

export const genericProjectTemplate: ProjectTemplate = {
  name: 'generic_project',
  description: 'Core-only starting vocabulary: no domain object types beyond the registered core.',
  object_types: [],
  interfaces: [],
};

export const projectTemplates = [softwareProjectTemplate, genericProjectTemplate] as const;
