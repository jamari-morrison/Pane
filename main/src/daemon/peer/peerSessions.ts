import type { PaneCommandRegistry } from '../commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PeerSessionInfo } from './peerPolicy';

const sessionListSchema = boundary.object({
  sessions: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    name: boundary.string,
    archived: boundary.optional(boundary.boolean),
    agent: boundary.nonEmptyString,
    internalSessionId: boundary.nonEmptyString,
    panelIds: boundary.jsonObject,
  })),
});

/** Reads this host's Sessions through the same registry the local CLI uses. */
export async function readPeerSessions(registry: Pick<PaneCommandRegistry, 'invoke'>): Promise<PeerSessionInfo[]> {
  const result = decodeBoundary(await registry.invoke('runpane:sessions:list', []), sessionListSchema);
  return result.sessions.flatMap(session => {
    const orchestratorPanelId = session.panelIds[session.agent];
    if (typeof orchestratorPanelId !== 'string' || !orchestratorPanelId) return [];
    return [{
      id: session.id,
      name: session.name,
      archived: session.archived === true,
      internalSessionId: session.internalSessionId,
      orchestratorPanelId,
    }];
  });
}
