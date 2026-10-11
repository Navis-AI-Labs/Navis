#!/usr/bin/env node
import { invokeBridge } from '@navis/bridge-daemon';
import { run } from '../commands/invocation.js';
process.exitCode = await run(process.argv.slice(2), {
  cwd: () => process.cwd(),
  send: invokeBridge,
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
