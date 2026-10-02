import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/session';
import { keepRepositoryPanes } from './repositoryPanes';

function pane(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: overrides.name ?? id,
    worktreePath: '',
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    isMainRepo: overrides.isMainRepo ?? false,
    archived: overrides.archived ?? false,
  };
}

describe('keepRepositoryPanes', () => {
  it('keeps a repository Pane the list showed when the host still has it', async () => {
    const main = pane('main', { isMainRepo: true, name: 'repo (Main)' });
    const worktree = pane('worktree');
    const fetchSession = vi.fn(async (id: string) => (id === 'main' ? main : undefined));

    const result = await keepRepositoryPanes([main, worktree], [worktree], fetchSession);

    expect(result.map(session => session.id)).toEqual(['worktree', 'main']);
  });

  it('drops a repository Pane the host archived or no longer has, and never re-adds other Panes', async () => {
    const archived = pane('archived-main', { isMainRepo: true });
    const gone = pane('gone-main', { isMainRepo: true });
    const removedWorktree = pane('removed-worktree');
    const fetchSession = vi.fn(async (id: string) => (id === 'archived-main' ? { ...archived, archived: true } : undefined));

    const result = await keepRepositoryPanes([archived, gone, removedWorktree], [], fetchSession);

    expect(result).toEqual([]);
    expect(fetchSession).not.toHaveBeenCalledWith('removed-worktree');
  });
});
