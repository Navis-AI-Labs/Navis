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
      name: 'contracts-do-not-import-server-implementation',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^(packages/(application|domain|infrastructure)|services|apps)' },
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
