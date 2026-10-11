import fs from 'node:fs';
import process from 'node:process';

// The Node base image reserves this account for application processes.
const serviceUid = 1000;
const serviceGid = 1000;
fs.mkdirSync('/run/navis', { recursive: true, mode: 0o700 });
fs.chmodSync('/run/navis', 0o700);
for (const name of ['database-url', 'model-key']) {
  const target = `/run/navis/${name}`;
  fs.copyFileSync(`/run/secrets/${name}`, target);
  fs.chmodSync(target, 0o400);
  fs.chownSync(target, serviceUid, serviceGid);
}
fs.chownSync('/run/navis', serviceUid, serviceGid);
process.setgroups([]);
process.setgid(serviceGid);
process.setuid(serviceUid);
await import('../dist/platform/index.js');
