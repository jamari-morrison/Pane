import type { Session } from '../types/session';

/**
 * The full session list (`sessions:get-all`) leaves out repository (Main) Panes; one reaches the
 * list only when its repository view is opened. A reconnect to the same host reloads the list, so
 * keep the repository Panes it already showed, as long as the host still has them unarchived.
 */
export async function keepRepositoryPanes(
  shown: Session[],
  reloaded: Session[],
  fetchSession: (sessionId: string) => Promise<Session | undefined>,
): Promise<Session[]> {
  const reloadedIds = new Set(reloaded.map(session => session.id));
  const kept: Session[] = [];
  for (const session of shown) {
    if (!session.isMainRepo || reloadedIds.has(session.id)) continue;
    const current = await fetchSession(session.id);
    if (current?.isMainRepo && !current.archived) kept.push(current);
  }
  return [...reloaded, ...kept];
}
