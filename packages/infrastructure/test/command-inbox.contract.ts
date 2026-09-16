import { describe, expect, it } from 'vitest';

import type { BeginResult, CommandInbox } from '@navis/domain';

export function commandInboxContractSuite(
  name: string,
  make: () => CommandInbox | Promise<CommandInbox>,
): void {
  describe(name, () => {
    const project = '01923b10-0000-7000-8000-000000000001';
    const otherProject = '01923b10-0000-7000-8000-000000000002';

    it('begin returns fresh exactly once for a new key', async () => {
      const inbox = await make();
      const first = await inbox.begin(project, 'k1', 'create_project', 'sha256:'.padEnd(71, 'a'));
      expect(first).toEqual({ status: 'fresh' });
      const again = await inbox.begin(project, 'k1', 'create_project', 'sha256:'.padEnd(71, 'a'));
      expect(again).toEqual({ status: 'processing' });
    });

    it('replay returns the stored outcome byte-identically', async () => {
      const inbox = await make();
      const outcome = { status: 'applied', result: '{"ok":true,"value":42}' } as const;
      await inbox.begin(project, 'k2', 'create_project', 'sha256:'.padEnd(71, 'b'));
      await inbox.complete(project, 'k2', outcome);
      expect(await inbox.begin(project, 'k2', 'create_project', 'sha256:'.padEnd(71, 'b'))).toEqual(
        {
          status: 'replay',
          outcome,
        },
      );
    });

    it('failed outcome is equally replayable', async () => {
      const inbox = await make();
      const outcome = { status: 'failed', result: '{"ok":false,"code":"x"}' } as const;
      await inbox.begin(project, 'k3', 'create_project', 'sha256:'.padEnd(71, 'c'));
      await inbox.complete(project, 'k3', outcome);
      const second = await inbox.begin(project, 'k3', 'create_project', 'sha256:'.padEnd(71, 'c'));
      expect(second).toEqual({ status: 'replay', outcome });
    });

    it('same key with a different payload hash is refused loudly', async () => {
      const inbox = await make();
      await inbox.begin(project, 'k4', 'create_project', 'sha256:'.padEnd(71, 'd'));
      await expect(inbox.begin(project, 'k4', 'create_project', 'sha256:deadbeef')).rejects.toThrow(
        /collides-with-different-payload/,
      );
    });

    it('claims are project-scoped', async () => {
      const inbox = await make();
      await inbox.begin(project, 'k5', 'create_project', 'sha256:'.padEnd(71, 'e'));
      expect(
        await inbox.begin(otherProject, 'k5', 'create_project', 'sha256:'.padEnd(71, 'e')),
      ).toEqual({ status: 'fresh' });
    });

    it('same key and payload with a different command type is refused loudly', async () => {
      const inbox = await make();
      const hash = 'sha256:'.padEnd(71, '9');
      await inbox.begin(project, 'k9', 'create_project', hash);
      await expect(inbox.begin(project, 'k9', 'rename_project', hash)).rejects.toThrow(
        /collides-with-different-payload/,
      );
    });

    it('complete on an unknown key refuses loudly', async () => {
      const inbox = await make();
      await expect(
        inbox.complete(project, 'never-began', { status: 'applied', result: '{}' }),
      ).rejects.toThrow(/has-no-claim/);
    });

    it('a claim cannot be completed twice', async () => {
      const inbox = await make();
      await inbox.begin(project, 'k6', 'create_project', 'sha256:'.padEnd(71, 'f'));
      await inbox.complete(project, 'k6', { status: 'applied', result: 'one' });
      await expect(
        inbox.complete(project, 'k6', { status: 'applied', result: 'two' }),
      ).rejects.toThrow(/collides-with-different-payload/);
    });

    it('received stays processing until completed', async () => {
      const inbox = await make();
      await inbox.begin(project, 'k7', 'create_project', 'sha256:'.padEnd(71, '0'));
      expect(await inbox.begin(project, 'k7', 'create_project', 'sha256:'.padEnd(71, '0'))).toEqual(
        { status: 'processing' },
      );
    });
  });
}

/** Type-level pin so the contract suite exercises the port shape, not adapter types. */
export type { BeginResult };
