import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonObject } from '../../boundaryDecoder';
import type { SandboxCommandResult, SandboxHandle } from '../provider';
import type { TailscaleApi, TailscaleDevice } from '../tailscale';
import { provisionSandbox, redact, repairSandboxTailnet, updateSandboxPane, type ProvisionStep } from './provision';

const FQDN = 'rp-abc12345.tail1234.ts.net';
const PAIRING = `pane-remote://${Buffer.from(JSON.stringify({
  v: 1, label: 'Cloud', baseUrl: `https://${FQDN}`, token: 'paired-token', transport: 'http+sse',
  tunnel: { kind: 'tailscale', selected: true },
})).toString('base64url')}`;
const RUNNING: JsonObject = { ok: true, backendState: 'Running', nodeId: 'n-new', hostname: 'rp-abc12345', magicDnsName: FQDN, tags: ['tag:rp-session'], runSsh: false };

/** How a fake sandbox answers one rp-bootstrap.sh step, given its arguments. */
type StepAnswer = (args: string[]) => JsonObject;

const answer = (payload: JsonObject): StepAnswer => () => payload;

/** A sandbox whose rp-bootstrap.sh steps answer from `answers`; records each step and written file. */
function fakeSandbox(answers: Map<string, StepAnswer>) {
  const steps: Array<{ name: string; args: string[] }> = [];
  const files = new Map<string, string>();
  const handle: SandboxHandle = {
    id: 'bx_1',
    async writeFile(path, content) {
      files.set(path, content);
    },
    async runScript(script): Promise<SandboxCommandResult> {
      const words = [...script.matchAll(/'((?:[^']|'\\'')*)'/gu)].map((match) => match[1]);
      if (!words[0]?.endsWith('/rp-bootstrap.sh')) return { exitCode: 0, stdout: '', stderr: '' };
      const [, name, ...args] = words;
      steps.push({ name, args });
      const respond = answers.get(name);
      if (respond === undefined) return { exitCode: 1, stdout: `RP_RESULT ${JSON.stringify({ ok: false, error: `unexpected step ${name}` })}\n`, stderr: '' };
      const payload = respond(args);
      return { exitCode: 0, stdout: `progress\nRP_RESULT ${JSON.stringify(payload)}\n`, stderr: '' };
    },
  };
  return { handle, steps, files, names: () => steps.map((step) => step.name) };
}

function fakeTailnet(devices: TailscaleDevice[] = []) {
  const deleted: string[] = [];
  const api: TailscaleApi = {
    mintAuthKey: async () => ({ id: 'k1', key: 'tskey-fake-k1-SECRET' }),
    listDevices: async () => devices,
    findDevicesByHostname: async () => devices,
    deleteDevice: async (nodeId) => {
      deleted.push(nodeId);
      return true;
    },
  };
  return { api, deleted };
}

/** /health answers ready only on the given base URLs. */
function healthFetch(readyBases: string[]): typeof fetch {
  return async (input) => {
    const ready = readyBases.some((base) => String(input) === `${base}/health`);
    if (!ready) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true, status: 'ready', version: '2.4.146' }), { status: 200 });
  };
}

const freshSandboxAnswers = () => {
  let joined = false;
  return new Map<string, StepAnswer>([
    ['identity', answer({ ok: true, reset: true })],
    ['tailscale-install', answer({ ok: true })],
    ['tailnet-identity', () => (joined ? RUNNING : { ok: true, backendState: 'NeedsLogin' })],
    ['check', answer({ ok: true, passed: 30 })],
    ['firewall', answer({ ok: true, allowedTcp: [443] })],
    ['tailscale-up', () => {
      joined = true;
      return RUNNING;
    }],
    ['agent-env', answer({ ok: true })],
    ['agent-prompts', answer({ ok: true, trustedFolders: 1 })],
    ['install-pane', answer({ ok: true, version: '2.4.146' })],
    ['pairing-read', answer({ ok: true, code: PAIRING })],
    ['cert-status', answer({ ok: true, rateLimited: true, detail: 'too many certificates' })],
    ['health-local', answer({ ok: true })],
    ['serve-http', answer({ ok: true, baseUrl: `http://${FQDN}:42137` })],
    ['serve-guard', answer({ ok: true, applied: false })],
  ]);
};

test('provisions over HTTPS: identity, check, firewall, tagged join, agent env, install, pairing, health, serve guard', async () => {
  const sandbox = fakeSandbox(freshSandboxAnswers());
  const tailnet = fakeTailnet();
  const steps: ProvisionStep[] = [];
  const result = await provisionSandbox(sandbox.handle, {
    sessionId: 'abc12345xyz',
    label: 'Cloud',
    hostname: 'rp-abc12345',
    tailscale: tailnet.api,
    paneSource: { kind: 'deb-url', url: 'https://example.com/pane.deb', sha256: 'a'.repeat(64) },
    agentEnv: 'CLAUDE_CODE_OAUTH_TOKEN=claude-secret',
    fetchImpl: healthFetch([`https://${FQDN}`]),
    onStep: (step) => steps.push(step),
  });

  assert.deepEqual(sandbox.names(), [
    'identity', 'tailscale-install', 'tailnet-identity', 'check', 'firewall', 'tailscale-up', 'agent-env', 'agent-prompts', 'install-pane',
    'pairing-read', 'serve-guard',
  ]);
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'firewall')?.args, ['443']);
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'install-pane')?.args,
    ['deb-url', 'https://example.com/pane.deb', 'a'.repeat(64), '', 'Cloud']);
  assert.equal(sandbox.files.get('/home/user/.runpane-cloud/agent.env'), 'CLAUDE_CODE_OAUTH_TOKEN=claude-secret\n');
  assert.equal(result.transport, 'https');
  assert.equal(result.pairing.baseUrl, `https://${FQDN}`);
  assert.equal(result.nodeId, 'n-new');
  assert.equal(result.daemonVersion, '2.4.146');
  // Progress details never carry a secret.
  assert.doesNotMatch(JSON.stringify(steps), /claude-secret|paired-token|tskey-|pane-remote/u);
});

test('auto switches to plain HTTP inside the tailnet when the HTTPS certificate does not come', async () => {
  const sandbox = fakeSandbox(freshSandboxAnswers());
  const result = await provisionSandbox(sandbox.handle, {
    sessionId: 'abc12345xyz',
    label: 'Cloud',
    hostname: 'rp-abc12345',
    tailscale: fakeTailnet().api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' },
    autoHttpsWaitMs: 1,
    fetchImpl: healthFetch([`http://${FQDN}:42137`]),
  });
  assert.equal(result.transport, 'http');
  assert.equal(result.pairing.baseUrl, `http://${FQDN}:42137`);
  assert.equal(result.pairing.token, 'paired-token');
  assert.ok(!sandbox.names().includes('agent-env'), 'no agent env without a saved sign-in');
  assert.ok(sandbox.names().includes('agent-prompts'), 'Claude Code\'s prompts are answered with or without a saved sign-in');
  assert.deepEqual(sandbox.steps.find((step) => step.name === 'serve-guard')?.args, ['http']);
});

test('a stale node of ours under the name is deleted before the join; anyone else\'s stops it', async () => {
  const stale: TailscaleDevice = { nodeId: 'n-old', id: '1', hostname: 'rp-abc12345', name: FQDN, addresses: [], tags: ['tag:rp-session'] };
  const tailnet = fakeTailnet([stale]);
  await provisionSandbox(fakeSandbox(freshSandboxAnswers()).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: tailnet.api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([`https://${FQDN}`]),
  });
  assert.deepEqual(tailnet.deleted, ['n-old']);

  const laptop: TailscaleDevice = { ...stale, nodeId: 'n-laptop', tags: [] };
  await assert.rejects(provisionSandbox(fakeSandbox(freshSandboxAnswers()).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: fakeTailnet([laptop]).api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([`https://${FQDN}`]),
  }), /runpane did not create/u);
});

test('a failing step is reported with its name and without secrets', async () => {
  const answers = freshSandboxAnswers();
  answers.set('install-pane', answer({ ok: false, error: `setup printed ${PAIRING} after tskey-fake-k1-SECRET` }));
  await assert.rejects(provisionSandbox(fakeSandbox(answers).handle, {
    sessionId: 'abc12345xyz', label: 'Cloud', hostname: 'rp-abc12345', tailscale: fakeTailnet().api,
    paneSource: { kind: 'runpane-npm', spec: 'runpane@latest' }, fetchImpl: healthFetch([]),
  }), (error: Error) => {
    assert.match(error.message, /step "install-pane" failed: setup printed <pairing-redacted> after <tskey-redacted>/u);
    return true;
  });
  assert.equal(redact('x pane-remote://abc y'), 'x <pairing-redacted> y');
});

test('repair leaves a running node joined and only re-applies a missing Serve config', async () => {
  const sandbox = fakeSandbox(new Map([
    ['tailnet-identity', answer(RUNNING)],
    ['ts-guard', answer({ ok: true })],
    ['serve-guard', answer({ ok: true, applied: true })],
  ]));
  const tailnet = fakeTailnet();
  const result = await repairSandboxTailnet(sandbox.handle, { hostname: 'rp-abc12345', tailscale: tailnet.api, oldNodeId: 'n-new', transport: 'https' });
  assert.deepEqual(result, { reenrolled: false, backendState: 'Running', serveApplied: true });
  assert.deepEqual(sandbox.names(), ['tailnet-identity', 'ts-guard', 'serve-guard']);
  assert.deepEqual(tailnet.deleted, []);
});

test('repair re-enrols a logged-out node under the same name and restores Serve', async () => {
  const old: TailscaleDevice = { nodeId: 'n-old', id: '1', hostname: 'rp-abc12345', name: FQDN, addresses: [], tags: ['tag:rp-session'] };
  const sandbox = fakeSandbox(new Map([
    ['tailnet-identity', answer({ ok: true, backendState: 'NeedsLogin' })],
    ['tailscale-reset', answer({ ok: true })],
    ['tailscale-up', answer(RUNNING)],
    ['serve-restore', answer({ ok: true })],
  ]));
  const tailnet = fakeTailnet([old]);
  const result = await repairSandboxTailnet(sandbox.handle, { hostname: 'rp-abc12345', tailscale: tailnet.api, oldNodeId: 'n-old', transport: 'https' });
  assert.equal(result.reenrolled, true);
  assert.deepEqual(tailnet.deleted, ['n-old']);
  assert.deepEqual(sandbox.names(), ['tailnet-identity', 'tailscale-reset', 'tailscale-up', 'serve-restore']);
  assert.equal(sandbox.steps[2].args[1], 'rp-abc12345');
});

test('update needs an https .deb and its sha256, then runs update-pane', async () => {
  const sandbox = fakeSandbox(new Map([['update-pane', answer({ ok: true, version: '2.4.147' })]]));
  await assert.rejects(updateSandboxPane(sandbox.handle, { debUrl: 'http://example.com/pane.deb', sha256: 'a'.repeat(64) }), /https:\/\//u);
  await assert.rejects(updateSandboxPane(sandbox.handle, { debUrl: 'https://example.com/pane.deb', sha256: 'nope' }), /sha256/u);
  assert.deepEqual(await updateSandboxPane(sandbox.handle, { debUrl: 'https://example.com/pane.deb', sha256: 'b'.repeat(64) }), { version: '2.4.147' });
  assert.deepEqual(sandbox.steps, [{ name: 'update-pane', args: ['https://example.com/pane.deb', 'b'.repeat(64)] }]);
});
