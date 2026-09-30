import { describe, expect, it } from 'vitest';
import { normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';

const cloud = {
  provider: 'boat',
  sandboxId: 'bx_abcdefgh',
  sessionId: 'k3j9q2m8x1',
  nodeId: 'nABCDEF11CNTRL',
  hostname: 'rp-k3j9q2m8',
  version: 1,
};

function configWithProfile(profile: Record<string, unknown>) {
  return {
    client: {
      profiles: [{
        id: 'cloud-k3j9q2m8x1',
        label: 'Checkout rewrite',
        baseUrl: 'https://rp-k3j9q2m8.tail0000.ts.net',
        token: 'token-value',
        transport: 'http+sse',
        ...profile,
      }],
      activeProfileId: null,
      mode: 'local',
    },
  };
}

describe('saved remote host profiles from runpane cloud', () => {
  it('keeps the cloud field when the desktop normalizes its config', () => {
    const normalized = normalizeRemoteDaemonConfig(configWithProfile({ cloud }));
    expect(normalized.client.profiles).toHaveLength(1);
    expect(normalized.client.profiles[0].cloud).toEqual(cloud);
  });

  it('still loads profiles without a cloud field', () => {
    const normalized = normalizeRemoteDaemonConfig(configWithProfile({}));
    expect(normalized.client.profiles[0].cloud).toBeUndefined();
  });

  it('skips a profile whose cloud field is malformed instead of loading half of it', () => {
    const normalized = normalizeRemoteDaemonConfig(configWithProfile({ cloud: { provider: 'other' } }));
    expect(normalized.client.profiles).toHaveLength(0);
  });
});
