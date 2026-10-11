import { parseArgs } from 'node:util';
import { createApiRuntime } from './composition.js';
import { loadRuntimeConfig } from './runtime-config.js';

export async function runOperator(argv: string[], output: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: 'string' }, kind: { type: 'string' } },
  });
  if (!values.name || (values.kind !== 'human' && values.kind !== 'agent'))
    throw new Error('Usage: operator --name <name> --kind human|agent');
  const runtime = await createApiRuntime(await loadRuntimeConfig(), {
    write(line) {
      process.stderr.write(`${line}\n`);
    },
  });
  try {
    if (runtime.provision === undefined) throw new Error('durable project runtime required');
    const credential = await runtime.provision(values.name, values.kind);
    output(JSON.stringify(credential));
  } finally {
    await runtime.close();
  }
}
