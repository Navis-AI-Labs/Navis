/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolved-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'domain-imports-no-other-navis-package',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^(packages/(contracts|application|infrastructure)/|services/|apps/)' },
    },
    {
      name: 'contracts-do-not-import-server-implementation',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^(packages/(application|domain|infrastructure)/|services/|apps/)' },
    },
    {
      name: 'application-does-not-import-concrete-adapters',
      severity: 'error',
      from: { path: '^packages/application/src' },
      to: { path: '^(packages/infrastructure/|services/|apps/)' },
    },
    {
      name: 'infrastructure-does-not-import-entry-points',
      severity: 'error',
      from: { path: '^packages/infrastructure/src' },
      to: { path: '^(services/|apps/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      conditionNames: ['types', 'import', 'default'],
      exportsFields: ['exports'],
    },
    includeOnly: '^(packages|services|apps)',
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
