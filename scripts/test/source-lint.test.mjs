import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { ESLint } from 'eslint';

test('strict source lint resolves public workspace entries without generated declarations', async (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'navis-source-lint-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['eslint.config.js', 'tsconfig.base.json', 'tsconfig.tooling.json'])
    copyFileSync(path.join(root, file), path.join(fixture, file));
  writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
  mkdirSync(path.join(fixture, 'packages/application/src'), { recursive: true });
  mkdirSync(path.join(fixture, 'services/api/src'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'packages/application/src/index.ts'),
    'export class ProjectService { state(): boolean { return true; } }\n',
  );
  const filename = path.join(fixture, 'services/api/src/composition.ts');
  const code =
    "import { ProjectService } from '@navis/application'; export const state = new ProjectService().state();\n";
  writeFileSync(filename, code);
  const eslint = new ESLint({
    cwd: fixture,
    overrideConfigFile: path.join(fixture, 'eslint.config.js'),
  });
  const valid = await eslint.lintText(code, { filePath: filename });
  assert.equal(valid[0].errorCount, 0, JSON.stringify(valid[0].messages));
  const invalid = await eslint.lintText(
    'declare const unsafe: any; export const value: string = unsafe;\n',
    { filePath: filename },
  );
  assert(
    invalid[0].messages.some(
      (message) => message.ruleId === '@typescript-eslint/no-unsafe-assignment',
    ),
  );
});
