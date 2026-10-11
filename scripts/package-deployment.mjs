import process from 'node:process';
import path from 'node:path';
import {
  readdirSync,
  realpathSync,
  statSync,
  copyFileSync,
  renameSync,
  rmSync,
  constants,
  readFileSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

/** pnpm may hard-link workspace outputs; deployment must remain stable across later builds. */
export function isolateDeploymentFiles(directory) {
  const root = realpathSync(directory);
  const selfName = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, realpathSync(file));
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          // Legacy deploy can point the package's own alias back at its workspace checkout.
          if (
            typeof selfName !== 'string' ||
            !file.endsWith(path.join('node_modules', ...selfName.split('/')))
          )
            throw new Error('Package deployment contains an external symbolic link');
          unlinkSync(file);
          symlinkSync(
            process.platform === 'win32' ? root : path.relative(path.dirname(file), root),
            file,
            'junction',
          );
        }
      } else if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && statSync(file).nlink > 1) {
        const temporary = `${file}.${randomUUID()}.copy`;
        try {
          copyFileSync(file, temporary, constants.COPYFILE_EXCL);
          renameSync(temporary, file);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
    }
  };
  walk(root);
}
