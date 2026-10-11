import { runOperator } from '../platform/operator-command.js';
await runOperator(process.argv.slice(2), (line) => {
  process.stdout.write(`${line}\n`);
});
