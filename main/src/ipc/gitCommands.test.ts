import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { WorktreeManager } from '../services/worktreeManager';
import type { CommandRunner } from '../utils/commandRunner';
import type { Project } from '../database/models';
import type { Session } from '../types/session';
import type { AppServices } from './types';
import { registerGitHandlers } from './git';

// SAFETY: These registry tests only need IpcMain.handle for channel binding.
const ipcStub = () => ({ handle: vi.fn() } as IpcMain);

type ProjectContext = NonNullable<ReturnType<AppServices['sessionManager']['getProjectContext']>>;

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each fixture implements every member sessions:get-git-commands
  // reaches; anything else fails the test immediately.
  return implementation as Contract;
}

/** A repo just cloned from origin: on `master`, with `origin/master` and nothing else. */
function freshCloneRunner(): CommandRunner {
  const execAsync = vi.fn(async (command: string) => {
    if (command === 'git branch --show-current') return { stdout: 'master\n', stderr: '' };
    if (command === 'git rev-parse --verify origin/master') return { stdout: 'abc123\n', stderr: '' };
    throw new Error(`fatal: unknown command or ref: ${command}`);
  });
  return partialMock<CommandRunner>({ execAsync });
}

function createRegistry(session: { isMainRepo: boolean; baseBranch?: string }) {
  const commandRunner = freshCloneRunner();
  const project = { id: 1, path: '/home/user/my-repo' };
  const services = partialMock<AppServices>({
    sessionManager: partialMock<AppServices['sessionManager']>({
      getSession: async () => partialMock<Session>({ id: 's1', worktreePath: '/home/user/my-repo', archived: false, ...session }),
      getProjectForSession: () => partialMock<Project>(project),
      getProjectContext: () => partialMock<ProjectContext>({ project: partialMock<Project>(project), commandRunner }),
    }),
    worktreeManager: new WorktreeManager(),
  });
  const registry = new PaneCommandRegistry();
  registerGitHandlers(ipcStub(), services, registry);
  return registry;
}

describe('sessions:get-git-commands', () => {
  it('reports origin for the main repo of a fresh clone, so its Changes view does not say origin is missing', async () => {
    // getOrCreateMainRepoSession stores origin/<branch> as the base whenever it exists.
    const registry = createRegistry({ isMainRepo: true, baseBranch: 'origin/master' });

    await expect(registry.invoke('sessions:get-git-commands', ['s1'])).resolves.toMatchObject({
      success: true,
      data: { comparisonBaseBranch: 'origin/master', originBranch: 'origin/master', currentBranch: 'master' },
    });
  });
});
