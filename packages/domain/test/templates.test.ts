import { describe, expect, it } from 'vitest';

import {
  genericProjectTemplate,
  projectTemplates,
  softwareProjectTemplate,
} from '../src/schema/templates/project-templates.js';
import { interfaceDefinitions } from '../src/schema/capability-interfaces.js';
import { linkTypeDefinitions } from '../src/schema/link-types.js';
import { validateVocabulary } from '../src/schema/vocabulary.js';

describe('preset templates', () => {
  it('provides exactly the two named templates', () => {
    expect(projectTemplates.map((t) => t.name)).toEqual(['software_project', 'generic_project']);
  });

  it('software_project references resolve through the vocabulary validation', () => {
    const template = softwareProjectTemplate;
    const relations = template.object_types.flatMap((o) => o.relations.map((r) => r.name));
    const issues = validateVocabulary(linkTypeDefinitions, interfaceDefinitions, relations, [
      ...template.interfaces,
      ...template.object_types.flatMap((o) => [...o.implements]),
    ]);
    expect(issues).toEqual([]);
  });

  it('generic_project defines no domain object types beyond the core vocabulary', () => {
    expect(genericProjectTemplate.object_types).toEqual([]);
    expect(genericProjectTemplate.interfaces).toEqual([]);
  });

  it('templates carry no action types, criteria references, or commands', () => {
    for (const template of projectTemplates) {
      const keys = Object.keys(template);
      expect(keys).toEqual(['name', 'description', 'object_types', 'interfaces']);
      expect(keys).not.toContain('action_types');
      expect(keys).not.toContain('criteria');
      expect(keys).not.toContain('commands');
    }
  });

  it('software_project declares the feature and pull request object types with implements', () => {
    const template = softwareProjectTemplate;
    expect(template.object_types.map((o) => o.name)).toEqual(['Feature', 'PullRequest']);
    expect(template.object_types.every((o) => o.implements.includes('Assetable'))).toBe(true);
  });
});
