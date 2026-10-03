#!/usr/bin/env node
// Live end-to-end run of "Add cloud sandbox" (initial-landing plan, Done when 1-4), driving the REAL packaged
// Pane desktop (no electronApiMock) under a display, from a clean profile, the way a user would:
//   credentials  Settings → Connections → Cloud sandboxes: enter boat key + wallet, Tailscale OAuth client,
//                Claude token; save.
//   add          Add cloud sandbox → listed in the section and the host switcher → connected.
//   agent        A new Pane on the sandbox, a Claude Code panel in it, a prompt it must answer.
//   stop         Stop from the row → stopped badge; the switcher offers Start.
//   start        Start → same tailnet name, the Pane is back, the Claude panel resumes its conversation.
//   remove       Remove → row, saved host, sandbox and tailnet device all gone.
//   hygiene      the pre-seeded remote is unchanged, local runtime still works, no secret in any evidence.
//
// MODE=fake runs the same phases with 0 boat starts: a second headless daemon of the same build on loopback
// stands in for the sandbox ("add" saves it as a host, "stop" SIGKILLs it like a power loss, "start"
// respawns it, "remove" deletes the saved host). It exercises the switcher, Pane, Claude and resume path.
//
// Run through run.sh (download, verify, extract, xvfb). State lives in $WORK/state.json, so phases can be
// run one invocation at a time (PHASES=agent,stop).
import { _electron as electron } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSecret, loadSecret, redact, scanForSecrets, secretNames, secretValue } from './secrets.mjs';
import { boatSandboxes, boatSandbox, daemonInvoke, health, hostPaneSet, panesWithClaude, sandboxAgentState, savedHostToken, savedHosts, tailnetDevices } from './oracles.mjs';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`e2e: set ${name}`);
  return env[name];
};
const realHome = os.homedir();
// live: a fresh isolated profile on this machine; fake: the same with a loopback stand-in host;
// relay: SOBECK's installed side-by-side test build, its own data dir and the credentials Red entered in it.
const mode = ['fake', 'relay'].includes(env.MODE) ? env.MODE : 'live';
const relay = mode === 'relay';
const paneBin = path.resolve(required('PANE_BIN'));
const work = path.resolve(required('WORK'));
const out = path.resolve(required('OUT'));
const windows = process.platform === 'win32';
// FAKE_CLAUDE=1 (fake only): the fake host runs fake-claude.mjs as `claude` instead of Claude Code (CI, no token).
const fakeClaude = mode === 'fake' && env.FAKE_CLAUDE === '1';
const home = relay ? realHome : path.join(work, 'home');
// A side-by-side build (SIDE_BY_SIDE_NAME) keeps its data in ~/.pane_<name> whatever PANE_DIR says.
let paneDir = relay ? path.resolve(required('PANE_DATA_DIR'))
  : env.SIDE_BY_SIDE_NAME ? path.join(home, `.pane_${env.SIDE_BY_SIDE_NAME}`) : path.join(home, '.pane');
for (const forbidden of [path.join(realHome, '.pane'), path.join(realHome, '.pane_remote'), ...(relay ? [] : [realHome])]) {
  if ([relay ? '' : home, paneDir].map((dir) => dir.toLowerCase()).includes(forbidden.toLowerCase())) throw new Error(`e2e: refusing to use ${forbidden}`);
}
if (paneBin.startsWith('/opt/') || paneBin === '/usr/bin/pane' || /[\\/]Programs[\\/]Pane[\\/]/i.test(paneBin)) {
  throw new Error('e2e: PANE_BIN must be the test build, never the installed Pane');
}
// model-follow (D2): after DW2, the user changes their default and the sandbox's next new Claude panel follows.
// model-detect (D2 ii): with NO explicit default the sandbox runs what local Claude actually uses.
// home-detect (D2 ii, Red's HOME-go): a second desktop on the same sandbox runs as agentbox's real user (HOME=/home/agent,
// side-by-side build) with no explicit default; its offline detection must give the sandbox's next panel that model.
// model-detect (token-only variant) is opt-in (PHASES=...): it can't tell D2 from no-D2 (iface-cs 20:45Z).
const allPhases = ['credentials', 'add', 'agent', 'stop', 'start', 'model-follow', ...(env.PANE_BIN_SBS ? ['home-detect'] : []), 'remove', 'hygiene'];
const phases = (env.PHASES ? env.PHASES.split(',') : allPhases)
  .filter((phase) => mode !== 'fake' || phase !== 'credentials')
  // On SOBECK the user's real default is only read, never changed.
  .filter((phase) => !relay || !['model-follow', 'model-detect', 'home-detect'].includes(phase))
  // A fake host is never provisioned, so D2 can't reach it.
  // FAKE_HOME_DETECT=1: a dry run of the HOME-go mechanics against the fake host (its model checks can't pass there).
  .filter((phase) => mode !== 'fake' || phase !== 'model-detect')
  .filter((phase) => mode !== 'fake' || phase !== 'home-detect' || env.FAKE_HOME_DETECT === '1');
const maxStarts = Number(env.MAX_STARTS ?? (relay ? 2 : 6));
const startsLog = env.STARTS_LOG ?? (relay ? path.join(out, 'starts.txt') : path.join(realHome, 'rc-loop/evidence/cs-e2e/starts.txt'));
const secretsDir = env.SECRETS_DIR ?? path.join(realHome, 'rc-loop/secrets');
const boatOrg = env.BOAT_ORG ?? 'test';
if (mode === 'live' && boatOrg !== 'test') throw new Error('e2e: live runs use the boat test org only (BOAT_ORG=test)');
if (mode !== 'fake' && env.FAKE_TRUST_PROJECT) throw new Error('e2e: FAKE_TRUST_PROJECT is for fake runs only');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(paneDir, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- state, log, checks, timings
const statePath = path.join(work, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const saveState = () => fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const results = { mode, phases, checks: [], timings: {}, findings: [] };
const log = (...parts) => {
  const line = redact(`${new Date().toISOString()} ${parts.join(' ')}`);
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const check = (name, ok, detail = '') => {
  results.checks.push({ name, verdict: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail: redact(detail) });
  log(ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', name, detail);
  return ok;
};
const timing = (name, startedAt) => {
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  results.timings[name] = seconds;
  log('TIME', name, `${seconds} s`);
  return seconds;
};
const finding = (text) => {
  results.findings.push(redact(text));
  log('FINDING', text);
};
const until = async (probe, timeoutMs, everyMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};

function countStart(what) {
  fs.mkdirSync(path.dirname(startsLog), { recursive: true });
  const used = fs.existsSync(startsLog) ? fs.readFileSync(startsLog, 'utf8').split('\n').filter(Boolean).length : 0;
  if (used >= maxStarts) throw new Error(`e2e: start budget used (${used}/${maxStarts} in ${startsLog})`);
  fs.appendFileSync(startsLog, `${new Date().toISOString()} ${what} ${state.label ?? ''}\n`);
  log(`boat start ${used + 1}/${maxStarts}: ${what}`);
}

// ---------------------------------------------------------------- secrets
if (mode === 'live') {
  loadSecret('boatApiKey', path.join(secretsDir, 'boat.hdr'), (text) => text.trim().replace(/^Authorization: Bearer /, ''));
  loadSecret('tailscaleClientSecret', path.join(secretsDir, 'TAILSCALE_OAUTH_SECRET'));
  // The client id is not secret, but it is kept with the rest so it is typed from one place.
  addSecret('tailscaleClientId', env.TAILSCALE_CLIENT_ID ?? 'krreHuCr3M11CNTRL');
}
if (relay) {
  // Nothing secret comes from files here; the saved host tokens are registered so they are redacted.
  for (const host of savedHosts(paneDir)) addSecret(`savedHostToken:${host.label}`, savedHostToken(paneDir, host.id));
  // The credentials Red saved in the app: every long string in the library's credentials file, kept in memory
  // only so logs are redacted and the evidence is searched for them.
  const credentialsFile = path.join(env.RUNPANE_CLOUD_DIR ?? path.join(env.XDG_CONFIG_HOME ?? path.join(realHome, '.config'), 'runpane-cloud'), 'credentials.json');
  const register = (value, keyPath) => {
    if (typeof value === 'string' && value.length >= 16) addSecret(`cloudCredential:${keyPath}`, value);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) register(child, `${keyPath}.${key}`);
  };
  try {
    register(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')), 'credentials');
  } catch {
    // No saved credentials yet: the credentials phase reports it.
  }
} else if (!fakeClaude) {
  // claude-slot names the secrets file of the Claude token the loop's agents currently use.
  const claudeSlot = fs.readFileSync(path.join(secretsDir, 'claude-slot'), 'utf8').trim();
  if (!claudeSlot) throw new Error('e2e: claude-slot is empty');
  loadSecret('claudeToken', path.join(secretsDir, claudeSlot));
}
log(`secrets loaded (names only): ${secretNames().join(', ')}`);

// ---------------------------------------------------------------- clean environment
// On SOBECK (and for Windows apps) the app gets the user's environment, minus anything Pane-related.
// ANTHROPIC_MODEL stays: it is part of the user's default model (D2), not a credential.
const relayEnv = () => Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() === 'ANTHROPIC_MODEL'
  || !/^(PANE_|RUNPANE_|ELECTRON_RUN_AS_NODE$|CLAUDE_CODE_OAUTH_TOKEN$|ANTHROPIC_)/i.test(name)));
// Nothing is inherited from the Pane session this harness runs in (PANE_*, RUNPANE_*, tokens): an app that
// saw PANE_DIR or PANE_SESSION_ID could talk to the machine's own Pane daemon.
const claudeBin = relay || windows || fakeClaude ? '' : (spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout ?? '').trim();
const basePath = [...new Set([path.dirname(process.execPath), claudeBin ? path.dirname(claudeBin) : '', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':');
function cleanEnv(extra) {
  // Windows apps need the system environment; the profile is isolated through the per-user dirs instead.
  if (windows) {
    return {
      ...relayEnv(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      ...extra,
    };
  }
  return {
    PATH: basePath,
    HOME: home,
    USER: os.userInfo().username,
    LANG: env.LANG ?? 'C.UTF-8',
    DISPLAY: env.DISPLAY ?? '',
    XAUTHORITY: env.XAUTHORITY ?? '',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_RUNTIME_DIR: path.join(work, 'run'),
    ...extra,
  };
}
fs.mkdirSync(path.join(work, 'run'), { recursive: true, mode: 0o700 });
// A Playwright trace records the launch options, environment included: no trace while the app's environment
// holds a token (cs-b8fa53a9 live run: the token reached trace.trace; caught by the scan, shredded).
const tokenInAppEnv = mode === 'live' && phases.includes('model-detect');
const appEnv = relay ? {
  ...relayEnv(),
  ...(env.PANE_DEB_URL ? { RUNPANE_CLOUD_PANE_DEB_URL: env.PANE_DEB_URL, RUNPANE_CLOUD_PANE_DEB_SHA256: env.PANE_DEB_SHA256 ?? '' } : {}),
  RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs',
} : cleanEnv({
  PANE_DIR: paneDir,
  // What the sandbox installs: the same build as this desktop (cs-e2e iface request).
  ...(env.PANE_DEB_URL ? { RUNPANE_CLOUD_PANE_DEB_URL: env.PANE_DEB_URL, RUNPANE_CLOUD_PANE_DEB_SHA256: env.PANE_DEB_SHA256 ?? '' } : {}),
  ...(mode === 'live' ? { RUNPANE_CLOUD_BOAT_ORG: boatOrg, RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs' } : {}),
  // D2 (ii): the desktop user's local Claude is signed in with the subscription token, so local Claude (and the
  // desktop's detection probe) has a real default to report. Never a copy of a login file (orchestrator).
  ...(tokenInAppEnv ? { CLAUDE_CODE_OAUTH_TOKEN: secretValue('claudeToken') } : {}),
});

// ---------------------------------------------------------------- the user's default model (D2/D3)
// The desktop user's default Claude model, resolved like the library's readLocalClaudeModel (D2): Pane's Claude
// panels pass no --model, so it is Claude Code's own default — ANTHROPIC_MODEL, else `model` in
// ~/.claude/settings.json. The isolated run has no ANTHROPIC_MODEL; on SOBECK both are Red's, read only.
const userClaudeSettings = path.join(home, '.claude', 'settings.json');
function localDefaultModel() {
  if (relay && env.ANTHROPIC_MODEL) return env.ANTHROPIC_MODEL;
  try {
    return JSON.parse(fs.readFileSync(userClaudeSettings, 'utf8')).model;
  } catch {
    return undefined;
  }
}
function clearLocalDefaultModel() {
  if (relay) throw new Error('e2e: never changes the SOBECK user\'s default model');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(userClaudeSettings, 'utf8'));
  } catch {
    return;
  }
  delete settings.model;
  fs.writeFileSync(userClaudeSettings, `${JSON.stringify(settings, null, 2)}\n`);
  log(`local default model cleared (${userClaudeSettings.replace(home, '~')})`);
}

function setLocalDefaultModel(model) {
  if (relay) throw new Error('e2e: never changes the SOBECK user\'s default model');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(userClaudeSettings, 'utf8'));
  } catch {
    // A fresh profile has none yet.
  }
  fs.mkdirSync(path.dirname(userClaudeSettings), { recursive: true });
  fs.writeFileSync(userClaudeSettings, `${JSON.stringify({ ...settings, model }, null, 2)}\n`);
  log(`local default model set to ${model} (${userClaudeSettings.replace(home, '~')})`);
}
if (!relay && !state.localDefaultSet) {
  setLocalDefaultModel(env.LOCAL_DEFAULT_MODEL ?? 'claude-opus-5-5');
  state.localDefaultSet = true;
  saveState();
}

// ---------------------------------------------------------------- the pre-seeded remote (hygiene)
// A saved remote that exists before the run; it must come out byte-for-byte the same (except order).
// On SOBECK the hosts already saved there (Scratch) play that part.
if (relay && !state.existingHosts) {
  state.existingHosts = savedHosts(paneDir).map((host) => ({ ...host, tokenSha256: crypto.createHash('sha256').update(savedHostToken(paneDir, host.id) ?? '').digest('hex') }));
  saveState();
}
// NO_EXISTING_REMOTE=1: no pre-seeded remote, like SOBECK (removing the sandbox then leaves no remote host at all).
if (!relay && !state.existingRemote && env.NO_EXISTING_REMOTE !== '1') {
  const token = crypto.randomBytes(24).toString('base64url');
  state.existingRemote = { id: crypto.randomUUID(), label: 'existing-remote', baseUrl: 'http://127.0.0.1:9', token, transport: 'http+sse' };
  const configPath = path.join(paneDir, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  config.remoteDaemon = { ...config.remoteDaemon, client: { profiles: [state.existingRemote], activeProfileId: null, mode: 'local' } };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  saveState();
}
if (state.existingRemote) addSecret('existingRemoteToken', state.existingRemote.token);

// ---------------------------------------------------------------- fake sandbox (MODE=fake)
const fakeHome = path.join(work, 'fake-home');
const fakeDir = path.join(fakeHome, '.pane');
const fakePort = Number(env.FAKE_PORT ?? 42199);
const fakeBaseUrl = `http://127.0.0.1:${fakePort}`;
const fakeBin = path.join(fakeHome, 'bin');
const fakeEnv = () => {
  const base = cleanEnv({
    HOME: fakeHome,
    ...(windows
      ? { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') }
      : { XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_DATA_HOME: path.join(fakeHome, '.local/share'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'), DISPLAY: '' }),
    ...(fakeClaude ? {} : { CLAUDE_CODE_OAUTH_TOKEN: secretValue('claudeToken') }),
    // What the sandbox daemon's systemd drop-ins set (rp-bootstrap.sh install_agent_dropins): agent panels resume
    // when the daemon starts, and Claude Code treats every folder of the disposable host as trusted.
    PANE_RESUME_AGENTS_ON_START: '1',
    CLAUDE_CODE_SANDBOXED: '1',
  });
  if (fakeClaude) {
    // One PATH entry whatever its case (Windows spells it Path), with the stand-in first.
    const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const value = base[key] ?? '';
    delete base[key];
    base.PATH = `${fakeBin}${path.delimiter}${value}`;
  }
  return base;
};

// `claude` on the fake host's PATH runs fake-claude.mjs (FAKE_CLAUDE=1), for cmd/PowerShell and for sh shells.
function installFakeClaude() {
  fs.mkdirSync(fakeBin, { recursive: true });
  const script = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  finding('FAKE_CLAUDE=1: the fake host runs a Claude stand-in (fake-claude.mjs), not Claude Code');
}

function fakeSetup() {
  fs.mkdirSync(fakeDir, { recursive: true, mode: 0o700 });
  // Claude Code with only an OAuth token still shows its onboarding; a provisioned sandbox is expected to
  // have this done, so the fake does it too.
  // What the bootstrap seeds on a sandbox (ruling B): onboarding done, bypass mode accepted, the home folder
  // (where projects and worktrees live) trusted.
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), `${JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [fakeHome]: { hasTrustDialogAccepted: true },
      // FAKE_TRUST_PROJECT=1 (fake only): also trust the project folder, to test the later phases before fix B.
      ...(env.FAKE_TRUST_PROJECT === '1' ? { [path.join(fakeHome, 'cs-e2e-project')]: { hasTrustDialogAccepted: true } } : {}),
    },
  })}\n`, { mode: 0o600 });
  if (env.FAKE_TRUST_PROJECT === '1') finding('FAKE_TRUST_PROJECT=1: the fake host trusts the project folder too (not what the bootstrap does)');
  // Without a git identity the first Pane in a new project fails ("Author identity unknown").
  fs.writeFileSync(path.join(fakeHome, '.gitconfig'), '[user]\n\tname = cs-e2e\n\temail = cs-e2e@localhost\n');
  if (fakeClaude) installFakeClaude();
  // FAKE_SYNC_MARKER=<model> (fake only): the library's sync marker as a provisioned sandbox has it, to prove the
  // harness reads it back through a real terminal (a fake host is never provisioned).
  if (env.FAKE_SYNC_MARKER) {
    fs.mkdirSync(path.join(fakeHome, '.runpane-cloud'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.runpane-cloud', 'claude-model'), env.FAKE_SYNC_MARKER);
  }
  const setup = spawnSync(paneBin, ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox', '--remote-setup', '--label', 'rp-loop-cs-fake', '--pane-dir', fakeDir, '--listen-port', String(fakePort),
    '--prefer-tunnel', 'manual', '--base-url', fakeBaseUrl, '--no-install-service'], { env: fakeEnv(), encoding: 'utf8', timeout: 120_000 });
  const code = (setup.stdout ?? '').match(/pane-remote:\/\/[A-Za-z0-9_-]+/)?.[0];
  if (setup.status !== 0 || !code) throw new Error(`fake host: --remote-setup exited ${setup.status} without a code`);
  const payload = JSON.parse(Buffer.from(code.slice('pane-remote://'.length), 'base64url').toString('utf8'));
  addSecret('fakeHostToken', payload.token);
  return payload;
}

function fakeDaemonStart() {
  const daemonLog = fs.openSync(path.join(work, 'fake-daemon.log'), 'a');
  const child = spawn(paneBin, ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox', '--daemon-headless', '--pane-dir', fakeDir],
    { env: fakeEnv(), stdio: ['ignore', daemonLog, daemonLog], detached: true, windowsHide: true });
  child.unref();
  state.fakePid = child.pid;
  saveState();
  return child.pid;
}

function fakeDaemonKill() {
  if (!state.fakePid) return false;
  if (windows) {
    // The whole process tree, forcibly: Windows has no process-group SIGKILL.
    if (spawnSync('taskkill', ['/PID', String(state.fakePid), '/T', '/F']).status !== 0) return false;
  } else {
    try {
      process.kill(-state.fakePid, 'SIGKILL');
    } catch {
      return false;
    }
  }
  delete state.fakePid;
  saveState();
  return true;
}

function fakeSaveHost(payload) {
  const configPath = path.join(paneDir, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  config.remoteDaemon = { ...config.remoteDaemon, client: { profiles: [], activeProfileId: null, mode: 'local', ...config.remoteDaemon?.client } };
  const profiles = config.remoteDaemon.client.profiles.filter((profile) => profile.label !== payload.label);
  profiles.push({ id: crypto.randomUUID(), label: payload.label, baseUrl: fakeBaseUrl, token: payload.token, transport: 'http+sse' });
  config.remoteDaemon.client.profiles = profiles;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------- app
let app;
let page;
let context;
let shotIndex = Number(state.shotIndex ?? 0);
const shot = async (name) => {
  const file = path.join(out, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  state.shotIndex = shotIndex;
  await page.screenshot({ path: file }).catch(() => undefined);
  const aria = await page.locator('body').ariaSnapshot().catch(() => '');
  fs.writeFileSync(file.replace(/\.png$/, '.aria.yml'), redact(aria));
};

async function launch({ bin = paneBin, launchEnv = appEnv, trace = !relay && !tokenInAppEnv } = {}) {
  app = await electron.launch({ executablePath: bin, args: ['--no-sandbox'], env: launchEnv, timeout: 120_000 });
  const mainLog = path.join(out, 'app-main.log');
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk) => fs.appendFileSync(mainLog, redact(chunk.toString())));
  context = app.context();
  // No trace on SOBECK (Red's own data on screen), nor while the app's environment holds a token; elsewhere a
  // trace with credentials paused out of it.
  tracing = trace;
  if (trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, title: `cloud-sandbox-e2e ${mode}` });
    await context.tracing.startChunk();
  }
  page = await app.firstWindow();
  page.on('console', (message) => fs.appendFileSync(path.join(out, 'app-console.log'), `${redact(`[${message.type()}] ${message.text()}`)}\n`));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  await dismissFirstRun();
}

let traceChunk = 0;
let tracing = false;
// Closes the running desktop, saving its trace first.
async function closeApp() {
  if (context && tracing) {
    await context.tracing.stopChunk({ path: path.join(out, `trace-${String(++traceChunk).padStart(2, '0')}.zip`) }).catch(() => undefined);
    await context.tracing.stop().catch(() => undefined);
  }
  tracing = false;
  await app?.close().catch(() => undefined);
  app = undefined;
  context = undefined;
}
async function pauseTrace() {
  if (!tracing) return;
  await context.tracing.stopChunk({ path: path.join(out, `trace-${String(++traceChunk).padStart(2, '0')}.zip`) });
}
async function resumeTrace() {
  if (!tracing) return;
  await context.tracing.startChunk();
}

// First-run dialogs a new user meets: the updater (an e2e build's version sorts before the release it is
// based on), onboarding, the welcome card. Dismissed the way a user would.
async function dismissFirstRun() {
  // Topmost first: onboarding ("Get Started") can open over the updater dialog.
  const steps = [
    ['Get Started → Skip', () => page.getByRole('button', { name: 'Skip', exact: true })],
    ['Welcome → Close modal', () => page.getByRole('dialog', { name: 'Welcome to Pane' }).getByRole('button', { name: 'Close modal' })],
    ['Software Update → Close', () => page.getByRole('dialog', { name: 'Software Update' }).getByRole('button', { name: 'Close', exact: true })],
  ];
  for (let round = 0; round < 8; round++) {
    await page.waitForTimeout(700);
    let dismissed = false;
    for (const [, target] of steps) {
      const button = target();
      if (await button.isVisible().catch(() => false) && await button.click({ timeout: 3000 }).then(() => true, () => false)) {
        dismissed = true;
        break;
      }
    }
    if (!dismissed) return;
  }
}

// ---------------------------------------------------------------- UI map
// Every accessible name the run depends on, in one place. Cloud-sandbox names follow the cs-e2e request in
// ~/rc-loop/ledger/iface-cs.md; adapt here when the desktop's differ.
const ui = {
  switcherChip: () => page.getByRole('button', { name: /Switch host$/ }).first(),
  connectedChip: (label) => page.getByRole('button', { name: `Agents run on ${label}. Switch host` }),
  hostItem: (label) => page.getByRole('menuitemradio', { name: new RegExp(escapeRegExp(label)) }),
  localItem: () => page.getByRole('menuitemradio', { name: /This computer/ }),
  manageConnections: () => page.getByRole('button', { name: /Manage connections/ }),
  // Settings → Remote Access page → "Cloud sandboxes (experimental)" (cs-desktop-ui's selector map, iface-cs).
  settingsButton: () => page.getByRole('button', { name: 'Settings', exact: true }),
  settingsDialog: () => page.getByRole('dialog', { name: /Pane Settings/ }),
  remoteAccessNav: () => ui.settingsDialog().getByRole('button', { name: 'Remote Access', exact: true }),
  cloudSection: () => ui.settingsDialog().getByRole('heading', { name: /Cloud sandboxes/i }),
  cloudPage: () => ui.settingsDialog(),
  credentialStatus: () => ui.settingsDialog().getByRole('definition'),
  credential: (label) => ui.settingsDialog().getByLabel(label, { exact: true }),
  saveCredentials: () => page.getByRole('button', { name: /Save credentials/i }),
  changeCredentials: () => page.getByRole('button', { name: /Change credentials/i }),
  nameInput: () => ui.settingsDialog().getByLabel('Name', { exact: true }),
  addSandbox: () => page.getByRole('button', { name: /Add cloud sandbox/i }),
  progress: (label) => page.getByRole('status', { name: `Progress for ${label}` }),
  row: (label) => page.getByRole('listitem', { name: `Cloud sandbox ${label}` }),
  rowAlert: (label) => ui.row(label).getByRole('alert'),
  rowAction: (verb, label) => page.getByRole('button', { name: `${verb} ${label}`, exact: true }),
  confirmDialog: (label) => page.getByRole('dialog', { name: `Remove ${label}?` }),
  newPaneIn: (repo) => page.getByRole('button', { name: repo ? `New pane in ${repo}` : /^New pane in / }),
  // The Pane's sidebar entry; a git status badge can precede the name ("main-1cs-e2e-…"), while its
  // "Archive …"/"Pin …" buttons have a space before it.
  paneButton: (name) => page.getByRole('button', { name: new RegExp(`^\\S*${escapeRegExp(name)}$`) }).first(),
  addTool: () => page.getByRole('button', { name: 'Add tool' }),
  claudeTool: () => page.getByRole('menuitem', { name: /Claude Code/ }),
  // A stopped sandbox's switcher entry reads "Stopped · Select to start"; selecting it starts, then connects.
  switcherStart: (label) => ui.hostItem(label).filter({ hasText: /Select to start/ }),
  claudeTab: () => page.getByRole('tab', { name: /Claude Code/ }).first(),
  // Shown while the project's Main Pane (the repository root) is the open one.
  mainPaneOpen: () => page.getByRole('separator', { name: /main repository/i }),
};
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const visible = (locator, timeout = 1000) => locator.waitFor({ state: 'visible', timeout }).then(() => true, () => false);

async function openSwitcher() {
  await dismissFirstRun();
  await closeSettings();
  await ui.switcherChip().click();
  await page.waitForTimeout(400);
}

async function closeMenus() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

async function openCloud() {
  await closeMenus();
  if (!(await visible(ui.settingsDialog(), 300))) await ui.settingsButton().click();
  await ui.remoteAccessNav().click();
  await ui.cloudSection().waitFor({ timeout: 10_000 });
}

// innerText keeps the row's line breaks; textContent runs the badge into its neighbours ("…5bRunningrp-…").
async function rowText(label) {
  return ((await ui.row(label).innerText({ timeout: 2000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ');
}
const rowBadge = (text, badge) => new RegExp(`(^|\\s)${badge}(\\s|$)`).test(text);

async function openConnections() {
  await openSwitcher();
  await ui.manageConnections().click();
  await page.waitForTimeout(800);
}

// The chip's name is the same while connected and after a failed connect; the switcher entry's status text
// ("Connected · <url>") is what tells them apart for a user.
let lastHostStatus = '';
async function isConnected(label) {
  if (!(await visible(ui.connectedChip(label), 500))) return false;
  await openSwitcher();
  const text = ((await ui.hostItem(label).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  await closeMenus();
  if (text !== lastHostStatus) log(`switcher: ${text}`);
  lastHostStatus = text;
  return /(?<!Dis)Connected\s*·/.test(text);
}

async function waitConnected(label, timeoutMs) {
  return Boolean(await until(() => isConnected(label), timeoutMs, 2000));
}

// Escape closes Settings unless the keystroke lands elsewhere (SOBECK Run 5: the switcher click behind the
// still-open dialog timed out); then its close button, like a user.
async function closeSettings() {
  const settings = page.getByRole('dialog', { name: /Pane Settings/ });
  if (!(await visible(settings, 500))) return;
  await page.keyboard.press('Escape');
  if (await settings.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
  await settings.getByRole('button', { name: /^Close/ }).first().click({ timeout: 5000 }).catch(() => undefined);
  if (!(await settings.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false))) throw new Error('Pane Settings does not close');
}

async function connectTo(label, timeoutMs = 60_000) {
  await openSwitcher();
  await ui.hostItem(label).click();
  return waitConnected(label, timeoutMs);
}

// ---------------------------------------------------------------- terminal (Claude panel) helpers
// The Claude panel's screen as the host's own terminal holds it (runpane:panels:screen), by panel id. The
// desktop's DOM is no source: with a GPU, xterm renders through WebGL and its rows hold no text (SOBECK Run 5).
async function terminalLines() {
  if (!state.claudePanelId) return [];
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  if (!host) return [];
  const screen = await daemonInvoke(host.baseUrl, savedHostToken(paneDir, host.id), 'runpane:panels:screen', { panelId: state.claudePanelId, limit: 80 }).catch(() => undefined);
  return String(screen?.text ?? '').replace(/\u00a0/g, ' ').split('\n');
}
const terminalText = async () => (await terminalLines()).join('\n');
const nonEmpty = (lines) => lines.filter((line) => line.trim() !== '');
const tail = (lines, count) => nonEmpty(lines).slice(-count).join('\n');
const lastLine = (lines) => nonEmpty(lines).at(-1) ?? '';

// The host's Panes and Claude panels by id, through its own API with the saved host token (memory only).
// Size of the Claude panel's transcript (<panelId>.jsonl) on the host: boat exec on a sandbox, the files on
// the fake host. Undefined where it can't be read (SOBECK).
async function transcriptSize() {
  const name = `${state.claudePanelId}.jsonl`;
  if (mode === 'fake') {
    const root = path.join(fakeHome, '.claude', 'projects');
    const found = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String).find((entry) => path.basename(entry) === name) : undefined;
    return found ? fs.statSync(path.join(root, found)).size : undefined;
  }
  if (relay) return undefined;
  return (await sandboxAgentState(state.cloud.sandboxId, boatOrg)).transcripts[name];
}

// The ACTUAL model a Claude panel ran: the first non-synthetic `message.model` in its transcript
// (<panelId>.jsonl) on the host. Fake host: read from its files. A sandbox: a plain terminal panel the harness
// opens in the same Pane through the host API prints only that field (works on SOBECK too, no boat access).
async function panelModel(panelId, paneId) {
  if (mode === 'fake' && env.MODEL_READ !== 'api') {
    const root = path.join(fakeHome, '.claude', 'projects');
    const file = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String).find((entry) => path.basename(entry) === `${panelId}.jsonl`) : undefined;
    if (!file) return undefined;
    return fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line).message?.model;
      } catch {
        return undefined;
      }
    }).find((model) => model && model !== '<synthetic>');
  }
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  const token = savedHostToken(paneDir, host.id);
  // A terminal panel whose command prints only the model field (the host API requires a tool object).
  const marker = `CSE2E_MODEL_${crypto.randomBytes(3).toString('hex')}`;
  const created = await daemonInvoke(host.baseUrl, token, 'runpane:panels:create', {
    paneId,
    type: 'terminal',
    noFocus: true,
    tool: {
      title: 'cs-e2e model probe',
      command: `echo ${marker}=$(grep -ho '"model":"[^"]*"' ~/.claude/projects/*/${panelId}.jsonl 2>/dev/null | grep -v synthetic | head -1)`,
    },
  });
  const probe = created?.panelId ?? created?.panel?.id;
  if (!probe) throw new Error('the host created no probe panel');
  const found = await until(async () => {
    const screen = await daemonInvoke(host.baseUrl, token, 'runpane:panels:screen', { panelId: probe, limit: 40 });
    return String(screen?.text ?? '').match(new RegExp(`${marker}="model":"([^"]+)"`))?.[1];
  }, 20_000, 1000);
  return found;
}

async function checkPanelModel(name, panelId, paneId, expected) {
  const actual = await panelModel(panelId, paneId).catch((error) => `unreadable (${error instanceof Error ? error.message : error})`);
  // D2 reaches cloud sandboxes (create/start/update and the desktop's sync); a fake host is never provisioned, so
  // there the model is recorded but not judged. Live and SOBECK runs FAIL on a mismatch.
  if (mode === 'fake') {
    check(name, null, `fake host (not provisioned, D2 applies to cloud sandboxes): panel ${panelId} ran ${actual ?? 'unknown'}; the user's default is ${expected ?? 'unset'}`);
    return actual;
  }
  if (!expected) {
    check(name, null, `no local default set (Claude Code's own default applies); the panel ran ${actual}`);
    return actual;
  }
  check(name, actual === expected, `panel ${panelId} ran ${actual ?? 'unknown'}; the user's default is ${expected}`);
  return actual;
}

async function hostPaneSetNow() {
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  if (!host) throw new Error(`no saved host "${state.label}"`);
  return hostPaneSet(host.baseUrl, savedHostToken(paneDir, host.id));
}

async function hostPanes() {
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  if (!host) throw new Error(`no saved host "${state.label}"`);
  return panesWithClaude(host.baseUrl, savedHostToken(paneDir, host.id));
}

// Claude Code's first-run screens must not appear on a provisioned host (ruling C, DW1): the bootstrap seeds
// ~/.claude.json. The harness never answers them for the user; it FAILs and stops.
async function waitClaudeReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await terminalLines();
    const text = tail(lines, 30);
    if (/Select login method|Paste code here/i.test(text)) throw new Error('Claude Code asks to log in: the Claude token did not reach the panel');
    const screens = [
      [/Yes, I trust this folder|Do you trust the files|Quick safety check/i, 'folder-trust prompt'],
      [/Yes, I accept|Bypass Permissions mode/i, 'bypass-permissions accept screen'],
      [/Choose the text style|Press Enter to continue/i, 'onboarding screen'],
    ].filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
    if (screens.length > 0) {
      await shot('claude-first-run-screen');
      check('claude-no-first-run-screens', false, `Claude Code showed: ${screens.join(', ')}`);
      throw new Error(`Claude Code showed ${screens.join(', ')}; not answered for the user`);
    }
    if (/\? for shortcuts|bypass permissions on/i.test(tail(lines, 6)) && !/\$\s*$/.test(lastLine(lines))) {
      check('claude-no-first-run-screens', true, 'straight to the Claude prompt');
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Claude Code was not ready within ${Math.round(timeoutMs / 1000)} s`);
}

async function askClaude(prompt, expected, timeoutMs = 240_000) {
  await page.locator('.xterm:visible').last().click();
  await page.keyboard.type(prompt, { delay: 10 });
  await page.keyboard.press('Enter');
  const startedAt = Date.now();
  const answered = await until(async () => (await terminalText()).includes(expected), timeoutMs, 1500);
  return { answered: Boolean(answered), ms: Date.now() - startedAt };
}

// ---------------------------------------------------------------- phases
async function phaseCredentials() {
  await openCloud();
  check('cloud-section-shown', await visible(ui.cloudSection(), 10_000), 'Settings → Remote Access has the Cloud sandboxes section');
  await shot('connections-before-credentials');
  if (relay) {
    // Red entered the credentials in this build once (Run 5 step 2); the proof only reads their state.
    const status = await ui.credentialStatus().allTextContents();
    check('credentials-ready', status.length >= 4 && status[0].trim() === 'Set' && status[2].trim() === 'Set' && (await visible(ui.addSandbox(), 2000)),
      `boat key ${status[0]}, Tailscale ${status[2]}, Claude ${status[3]}`);
    check('wallet-is-test', status[1]?.trim() === 'test', `the saved boat wallet is "${status[1]}"`);
    if (status[1]?.trim() !== 'test') throw new Error('the saved boat wallet is not "test": stop before creating anything');
    return;
  }
  if (await visible(ui.changeCredentials(), 1000)) {
    finding('credentials were already saved in this fresh profile');
    await ui.changeCredentials().click();
  }
  // No trace and no screenshot while values are in the inputs.
  await pauseTrace();
  const fields = [
    ['boat API key', 'boatApiKey'],
    ['Tailscale OAuth client ID', 'tailscaleClientId'],
    ['Tailscale OAuth client secret', 'tailscaleClientSecret'],
    ['Claude token', 'claudeToken'],
  ];
  for (const [label, name] of fields) await ui.credential(label).fill(secretValue(name));
  await ui.credential('boat wallet').fill(boatOrg);
  const startedAt = Date.now();
  await ui.saveCredentials().click();
  // Saving verifies the keys with boat and Tailscale; wait until the button is idle again.
  await until(async () => !(await ui.saveCredentials().isDisabled()) && !/Saving|Verifying/i.test((await ui.saveCredentials().textContent()) ?? ''), 30_000, 1000);
  const inputValues = await page.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value));
  const leftInInputs = fields.filter(([, name]) => inputValues.includes(secretValue(name))).map(([label]) => label);
  const bodyText = await page.locator('body').textContent() ?? '';
  const leftInText = fields.filter(([, name]) => bodyText.includes(secretValue(name))).map(([label]) => label);
  check('credentials-not-shown-after-save', leftInInputs.length === 0 && leftInText.length === 0,
    leftInInputs.length || leftInText.length ? `still visible: inputs ${JSON.stringify(leftInInputs)}, text ${JSON.stringify(leftInText)}` : 'no credential value in any input or text after saving');
  // Only now that nothing secret is on screen again.
  if (leftInInputs.length === 0 && leftInText.length === 0) await resumeTrace();
  else throw new Error('a credential stays on screen after saving; stopping before any trace or screenshot records it');
  timing('credentials-save', startedAt);
  const status = await ui.credentialStatus().allTextContents();
  check('credentials-ready', status.length >= 4 && ['Set', 'test', 'Set', 'Set'].every((want, index) => status[index]?.trim() === want),
    `boat key ${status[0]}, wallet ${status[1]}, Tailscale ${status[2]}, Claude ${status[3]}`);
  await shot('credentials-saved');
  const credentialFiles = listCredentialFiles();
  check('credentials-file-0600', credentialFiles.length > 0 && credentialFiles.every((file) => file.mode === '600'), JSON.stringify(credentialFiles));
}

function listCredentialFiles() {
  const roots = [path.join(home, '.config/runpane-cloud')];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const stat = fs.statSync(path.join(root, name));
      if (stat.isFile()) files.push({ file: path.join(root, name).replace(home, '~'), mode: (stat.mode & 0o777).toString(8) });
    }
  }
  return files;
}

async function phaseAdd() {
  if (mode === 'fake') {
    const payload = fakeSetup();
    fakeDaemonStart();
    const up = await until(() => health(fakeBaseUrl), 90_000);
    check('fake-host-up', Boolean(up), fakeBaseUrl);
    state.label = payload.label;
    saveState();
    // Saved while the app is closed, as a provisioned host is saved by the app itself.
    await app?.close();
    fakeSaveHost(payload);
    await launch();
  } else {
    state.label = env.LABEL ?? `rp-loop-cs-e2e-${crypto.randomBytes(3).toString('hex')}`;
    saveState();
    await openCloud();
    await ui.nameInput().fill(state.label);
    countStart('create');
    await ui.addSandbox().click();
    const startedAt = Date.now();
    const progress = [];
    let lastRow;
    let rowError;
    const listed = await until(async () => {
      const steps = await ui.progress(state.label).getByRole('listitem').allTextContents().catch(() => []);
      const latest = steps.at(-1)?.replace(/\s+/g, ' ').trim();
      if (latest && !progress.some((line) => line.endsWith(` ${latest}`))) progress.push(`${Math.round((Date.now() - startedAt) / 1000)} s ${latest}`);
      if (await visible(ui.rowAlert(state.label), 100)) {
        rowError = (await ui.rowAlert(state.label).textContent()) ?? 'error';
        return true;
      }
      const row = await rowText(state.label);
      if (row !== lastRow) log(`row: ${row || '(not found)'}`);
      lastRow = row;
      return rowBadge(row, 'Running');
    }, Number(env.ADD_TIMEOUT_MS ?? 600_000), 2000);
    fs.writeFileSync(path.join(out, 'add-progress.txt'), `${redact(progress.join('\n'))}\n`);
    if (rowError) {
      await shot('add-failed');
      check('add-listed-running', false, `row error after ${Math.round((Date.now() - startedAt) / 1000)} s: ${rowError}`);
      throw new Error(`Add cloud sandbox failed: ${rowError}`);
    }
    timing('add-to-running', startedAt);
    check('add-listed-running', Boolean(listed), `row "${state.label}" shows running; progress steps: ${progress.length}`);
    await shot('sandbox-running');
    // D1: the sandbox runs this very build (the same .deb), so the row offers no update and doesn't call its
    // version different (SOBECK Run 5 attempt 1 showed "2.4.146~cs… (differs from this app)" + Update Pane).
    const row = await rowText(state.label);
    const offered = await visible(ui.rowAction('Update Pane', state.label), 1000);
    check('no-update-offer-same-build', !offered && !/differs from this app/i.test(row), `row: ${row}; Update Pane button: ${offered}`);
    await closeSettings();
    const host = savedHosts(paneDir).find((entry) => entry.cloud && entry.label === state.label) ?? savedHosts(paneDir).find((entry) => entry.cloud);
    check('saved-host-written', Boolean(host?.cloud?.sandboxId), JSON.stringify(host ?? null));
    if (host) {
      state.label = host.label;
      state.profileId = host.id;
      state.cloud = host.cloud;
      state.baseUrl = host.baseUrl;
      saveState();
      addSecret('sandboxHostToken', savedHostToken(paneDir, host.id));
      results.sandbox = { label: host.label, ...host.cloud };
    }
    if (host && !relay) {
      const sandbox = await boatSandbox(host.cloud.sandboxId, boatOrg);
      // boat reports the wallet a sandbox bills as `team`; test's id (p2-boat-org).
      const testOrgId = env.BOAT_TEST_ORG_ID ?? 'team_852d7300-6d4b-45ec-b14e-42b2f444616c';
      check('boat-sandbox-in-test-org', sandbox.exists && sandbox.team === testOrgId && /^rp-loop-cs-/.test(sandbox.name ?? ''), `boat: ${JSON.stringify(sandbox)}`);
      const devices = await tailnetDevices(host.cloud.hostname);
      check('tailnet-device-joined', devices.length === 1, JSON.stringify(devices));
      state.tailnetDevice = devices[0];
      saveState();
    }
    state.addStartedAt = startedAt;
  }
  const startedAt = Date.now();
  await openSwitcher();
  check('switcher-lists-sandbox', await visible(ui.hostItem(state.label), 15_000), state.label);
  await shot('switcher-lists-sandbox');
  await ui.hostItem(state.label).click();
  const connected = await waitConnected(state.label, 60_000);
  timing('pick-to-connected', startedAt);
  if (state.addStartedAt) timing('add-to-connected', state.addStartedAt);
  check('connected', connected, `switcher chip names ${state.label}`);
  await shot('connected');
}

async function ensureProject() {
  if (await visible(ui.newPaneIn(env.REPO), 15_000)) return;
  // A fresh sandbox may have no project yet: create one like a user (New Project, a new folder on the host).
  const projectPath = env.REMOTE_PROJECT_PATH ?? (mode === 'fake' ? path.join(fakeHome, 'cs-e2e-project') : '/home/user/cs-e2e-project');
  finding(`no project on the host after connecting; created one at ${projectPath} through Add New Repository`);
  await page.keyboard.press('Control+Shift+N');
  const dialog = page.getByRole('dialog', { name: /Add New Repository/ });
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByPlaceholder('Enter project name').fill('cs-e2e-project');
  await dialog.getByPlaceholder('/path/to/your/repository').fill(projectPath);
  await dialog.getByRole('button', { name: /Create|Add/ }).last().click();
  await visible(ui.newPaneIn(), 30_000);
}

async function phaseAgent() {
  if (!(await isConnected(state.label))) check('connected-for-agent', await connectTo(state.label), state.label);
  await ensureProject();
  state.paneName = state.paneName ?? `cs-e2e-${crypto.randomBytes(2).toString('hex')}`;
  saveState();
  const startedAt = Date.now();
  await ui.newPaneIn(env.REPO).first().click();
  const dialog = page.getByRole('dialog', { name: /^New Pane/ });
  // The dialog auto-fills the name from the branch once branches load; a fill before that ends up prefixed
  // ("main-1cs-e2e-…"). Fill until the field holds exactly the name and stays that way.
  const nameField = dialog.getByPlaceholder('Enter a name for your pane');
  await until(async () => (await nameField.inputValue()) !== '', 10_000, 300);
  const named = await until(async () => {
    if ((await nameField.inputValue()) !== state.paneName) await nameField.fill(state.paneName);
    await page.waitForTimeout(700);
    return (await nameField.inputValue()) === state.paneName;
  }, 15_000, 300);
  if (!named) throw new Error(`the New Pane name field does not keep "${state.paneName}"`);
  await dialog.getByRole('button', { name: /^Create/ }).click();
  const paneShown = await visible(ui.paneButton(state.paneName), 60_000);
  timing('create-pane', startedAt);
  check('pane-created', paneShown, `Pane "${state.paneName}" listed`);
  await page.waitForTimeout(1500);
  if (await visible(ui.mainPaneOpen(), 500)) finding(`after Create the project's Main Pane stayed open, not "${state.paneName}"; opened it from the sidebar`);
  // The agent must run in the new Pane (its worktree), never in the Main Pane.
  await ui.paneButton(state.paneName).click();
  await page.waitForTimeout(1500);
  check('new-pane-open', !(await visible(ui.mainPaneOpen(), 1000)), `"${state.paneName}" is the open Pane`);
  const newPane = (await hostPanes()).find((pane) => pane.name === state.paneName);
  state.paneId = newPane?.id;
  saveState();
  check('new-pane-id', Boolean(state.paneId), `Pane "${state.paneName}" is ${state.paneId} on the host`);
  // PANE_SETTLE_MS: how long a user looks at the new Pane before adding the Claude panel (default: at once).
  if (env.PANE_SETTLE_MS) await page.waitForTimeout(Number(env.PANE_SETTLE_MS));
  await ui.addTool().click();
  await ui.claudeTool().click();
  const claudeStartedAt = Date.now();
  await page.locator('.xterm:visible').last().waitFor({ timeout: 60_000 });
  // The panel's id first: its screen is read from the host by id.
  const created = await until(async () => (await hostPanes()).find((pane) => pane.id === state.paneId)?.claudePanels?.[0], 30_000, 1000);
  state.claudePanelId = created?.id;
  saveState();
  if (!state.claudePanelId) throw new Error(`no Claude panel appeared in "${state.paneName}" on the host`);
  await waitClaudeReady(120_000);
  timing('claude-panel-ready', claudeStartedAt);
  // By id, before prompting: exactly one Claude panel, in THIS Pane, and it is the active one.
  const panes = await hostPanes();
  const mine = panes.find((pane) => pane.id === state.paneId)?.claudePanels ?? [];
  const elsewhere = panes.filter((pane) => pane.id !== state.paneId && pane.claudePanels.length > 0).map((pane) => pane.name);
  state.claudePanelId = mine[0]?.id;
  saveState();
  check('claude-panel-in-new-pane', mine.length === 1 && elsewhere.length === 0 && mine[0].isActive,
    `Claude panels in "${state.paneName}" (${state.paneId}): ${JSON.stringify(mine)}; other Panes with a Claude panel: ${JSON.stringify(elsewhere)}`);
  if (!(mine.length === 1 && mine[0].isActive)) throw new Error('the Claude panel is not the active panel of the new Pane; not prompting');
  const a = 100 + crypto.randomInt(800);
  const b = 100 + crypto.randomInt(800);
  state.codeWord = `kestrel${crypto.randomInt(1000, 9999)}`;
  saveState();
  const reply = await askClaude(`The code word is ${state.codeWord}. Remember it. Now compute ${a}+${b} and reply with only SUM= followed by the result.`, `SUM=${a + b}`);
  results.timings['claude-first-answer'] = Math.round(reply.ms / 100) / 10;
  check('claude-answers', reply.answered, reply.answered ? `SUM=${a + b} after ${Math.round(reply.ms / 1000)} s` : 'no answer within the timeout');
  // D2/D3: the new panel runs the user's default model, read from its transcript on the host.
  state.firstPanelModel = await checkPanelModel('claude-model-is-user-default', state.claudePanelId, state.paneId, localDefaultModel());
  saveState();
  await shot('claude-answered');
}

// Every Pane row in the sidebar carries an "Archive <name>" button.
const sidebarPanes = async () => (await page.locator('[aria-label^="Archive "]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label').slice('Archive '.length)))).sort();

async function phaseStop() {
  // DW2 "same Panes": every Pane before Stop, by id on the host and by name in the sidebar.
  state.panesBefore = await hostPaneSetNow();
  state.sidebarBefore = await sidebarPanes();
  saveState();
  log(`Panes before Stop: host ${JSON.stringify(state.panesBefore)}; sidebar ${JSON.stringify(state.sidebarBefore)}`);
  await shot('panes-before-stop');
  // Control for DW2: the same window reload the start phase does, with no Stop/Start in between. A Pane missing
  // here as well is lost by the reload, not by Stop/Start.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  await dismissFirstRun();
  await waitConnected(state.label, 30_000);
  await visible(ui.paneButton(state.paneName), 30_000);
  await page.waitForTimeout(3000);
  state.sidebarAfterPlainReload = await sidebarPanes();
  saveState();
  const lostByReload = state.sidebarBefore.filter((name) => !state.sidebarAfterPlainReload.includes(name));
  log(`control: sidebar after a plain reload (no Stop/Start) ${JSON.stringify(state.sidebarAfterPlainReload)}; missing ${JSON.stringify(lostByReload)}`);
  if (lostByReload.length > 0) finding(`a plain window reload (no Stop/Start) already drops ${JSON.stringify(lostByReload)} from the sidebar`);
  const startedAt = Date.now();
  if (mode === 'fake') {
    check('fake-host-killed', fakeDaemonKill(), 'SIGKILL to the headless daemon (power loss)');
    await until(async () => !(await health(fakeBaseUrl)), 30_000, 1000);
    const downAt = Date.now();
    const noticed = await until(async () => !(await isConnected(state.label)), 60_000, 2000);
    if (noticed) timing('ui-notices-host-down', downAt);
    else finding('the switcher still said Connected 60 s after the host died');
    await shot('host-down');
  } else {
    // The desktop leaves the sandbox first, so nothing it does can be what brings the agent back after Start.
    if (!relay) state.agentBefore = await sandboxAgentState(state.cloud.sandboxId, boatOrg);
    await openSwitcher();
    await ui.localItem().click();
    await page.waitForTimeout(1500);
    await openCloud();
    await ui.rowAction('Stop', state.label).click();
    // D4: from the accepted Stop on, the row never says Running again; while stopping, the row AND the switcher say
    // Stopping with no Stop/Start; at the end Stopped with Start. Every row change is timed (stop-timeline.txt).
    let lastStopRow;
    const stopTimeline = [];
    let sawRunning = '';
    let accepted = false;
    let stoppingChecked = false;
    const stopped = await until(async () => {
      const row = await rowText(state.label);
      if (row !== lastStopRow) {
        stopTimeline.push(`${Math.round((Date.now() - startedAt) / 1000)} s ${row}`);
        log(`row: ${row}`);
      }
      lastStopRow = row;
      // Accepted = the row has left Running once (Stopping or Stopped); a Running after that is a stale or wrong state.
      if (rowBadge(row, 'Stopping') || rowBadge(row, 'Stopped')) accepted = true;
      if (accepted && rowBadge(row, 'Running') && !sawRunning) sawRunning = `${Math.round((Date.now() - startedAt) / 1000)} s: ${row}`;
      if (rowBadge(row, 'Stopping') && !stoppingChecked) {
        stoppingChecked = true;
        const stopShown = await visible(ui.rowAction('Stop', state.label), 300);
        const startShown = await visible(ui.rowAction('Start', state.label), 300);
        check('stopping-hides-actions', !stopShown && !startShown, `row while stopping: ${row}; Stop button ${stopShown}, Start button ${startShown}`);
        await shot('row-stopping');
        // The switcher, while still stopping: closes Settings, reads the entry, comes back.
        await closeSettings();
        await openSwitcher();
        const entry = ((await ui.hostItem(state.label).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
        const startOffered = await visible(ui.switcherStart(state.label), 500);
        const stillStopping = rowBadge(await (async () => { await closeMenus(); await openCloud(); return rowText(state.label); })(), 'Stopping');
        if (/Stopping/i.test(entry) || stillStopping) {
          check('switcher-shows-stopping', /Stopping/i.test(entry) && !startOffered, `switcher entry while stopping: "${entry}"; Start offered ${startOffered}`);
        } else {
          check('switcher-shows-stopping', null, `the stop finished before the switcher was read ("${entry}")`);
        }
      }
      return rowBadge(row, 'Stopped');
    }, Number(env.STOP_WAIT_MS ?? 1_000_000), 2000);
    fs.writeFileSync(path.join(out, 'stop-timeline.txt'), `${redact(stopTimeline.join('\n'))}\n`);
    timing('stop', startedAt);
    check('no-running-after-stop', !sawRunning, sawRunning ? `the row said Running after Stop was accepted (${sawRunning})` : `never Running after Stop; ${stopTimeline.length} row states`);
    if (!stoppingChecked) check('stopping-hides-actions', null, 'the row went to Stopped before a Stopping state was seen (fast stop)');
    check('row-stopped', Boolean(stopped), `row "${state.label}" shows stopped`);
    const startInRow = await visible(ui.rowAction('Start', state.label), 2000);
    const stopInRow = await visible(ui.rowAction('Stop', state.label), 300);
    check('row-stopped-offers-start', startInRow && !stopInRow, `Stopped row: Start ${startInRow}, Stop ${stopInRow}`);
    await shot('row-stopped');
    const sandbox = relay ? { exists: true, state: 'not checked on SOBECK' } : await boatSandbox(state.cloud.sandboxId, boatOrg);
    if (!relay) check('boat-stopped', sandbox.exists && !/running|active/i.test(sandbox.state ?? ''), `boat state ${sandbox.state}`);
    await openSwitcher();
    const startOffered = await visible(ui.switcherStart(state.label), 5000);
    check('switcher-offers-start', startOffered, 'a stopped sandbox has a Start action in the switcher');
    await shot('switcher-stopped');
    await closeMenus();
  }
}

async function phaseStart() {
  const startedAt = Date.now();
  if (mode === 'fake') {
    fakeDaemonStart();
    check('fake-host-restarted', Boolean(await until(() => health(fakeBaseUrl), 120_000)), fakeBaseUrl);
    timing('start-to-health', startedAt);
  } else {
    countStart('start');
    // Start from the row while the desktop is on This computer: the agent must come back on its own (ruling 3,
    // G2a), before the desktop attaches to the sandbox or opens the panel's tab.
    await openCloud();
    await ui.rowAction('Start', state.label).click();
    const running = await until(async () => rowBadge(await rowText(state.label), 'Running'), 600_000, 2000);
    timing('start-to-running', startedAt);
    check('row-running-again', Boolean(running), `row: ${await rowText(state.label)}`);
    await shot('row-running-again');
    await closeSettings();
    const attachedEarly = await visible(ui.connectedChip(state.label), 500);
    if (!relay) {
      const after = await until(async () => {
        const agents = await sandboxAgentState(state.cloud.sandboxId, boatOrg);
        return agents.claudeResume > 0 && /Resumed [1-9]/.test(agents.resumedLog) ? agents : undefined;
      }, 180_000, 5000) ?? await sandboxAgentState(state.cloud.sandboxId, boatOrg);
      timing('start-to-agent-resumed-on-sandbox', startedAt);
      const grown = Object.entries(after.transcripts).filter(([name, size]) => size > (state.agentBefore?.transcripts?.[name] ?? Infinity)).map(([name]) => name);
      check('agent-resumed-before-attach', !attachedEarly && after.claudeResume > 0 && /Resumed [1-9]/.test(after.resumedLog),
        `desktop attached: ${attachedEarly}; on the sandbox: ${after.claudeResume} claude --resume of ${after.claude} claude processes, log "${after.resumedLog}"; transcripts before ${JSON.stringify(state.agentBefore?.transcripts)}, after ${JSON.stringify(after.transcripts)}; grown: ${JSON.stringify(grown)}`);
      results.agentResume = { before: state.agentBefore, after, grown };
    }
    const host = savedHosts(paneDir).find((entry) => entry.id === state.profileId);
    check('same-tailnet-name', host?.cloud?.hostname === state.cloud.hostname && host?.baseUrl === state.baseUrl,
      `before ${state.cloud.hostname} ${state.baseUrl}; after ${host?.cloud?.hostname} ${host?.baseUrl}`);
    const devices = relay ? [state.tailnetDevice] : await tailnetDevices(state.cloud.hostname);
    if (!relay) check('same-tailnet-device', devices.length === 1 && devices[0].id === state.tailnetDevice?.id, JSON.stringify(devices));
  }
  const connectedAt = Date.now();
  // Live: the desktop sat on This computer through Stop/Start, so the user now picks the sandbox again.
  let connected = mode === 'fake' ? await waitConnected(state.label, 90_000) : await connectTo(state.label, 90_000);
  if (!connected && mode === 'fake') {
    finding('after Start the desktop did not reconnect by itself within 90 s; picked the host again in the switcher');
    connected = await connectTo(state.label, 90_000);
  }
  timing('start-to-connected', startedAt);
  check('reconnected', connected, state.label);
  // What the user sees after reconnecting (no reload): every Pane the sidebar showed before Stop.
  await visible(ui.paneButton(state.paneName), 30_000);
  await page.waitForTimeout(3000);
  const sidebarAfterStart = await sidebarPanes();
  const missingInSidebar = (state.sidebarBefore ?? []).filter((name) => !sidebarAfterStart.includes(name));
  check('same-panes-in-sidebar', missingInSidebar.length === 0, `after Start ${JSON.stringify(sidebarAfterStart)}; missing: ${JSON.stringify(missingInSidebar)}`);
  await shot('panes-after-start');
  // Reload so the Pane list comes from the restarted host, not from what the window still shows.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  await dismissFirstRun();
  if (!(await waitConnected(state.label, 30_000))) {
    finding('after a window reload the restarted host was not connected; picked it again in the switcher');
    check('reconnected-after-reload', await connectTo(state.label), state.label);
  }
  const paneBack = await visible(ui.paneButton(state.paneName), 60_000);
  check('pane-back', paneBack, `Pane "${state.paneName}" listed after Start`);
  await page.waitForTimeout(3000);
  const panesAfter = await hostPaneSetNow().catch(() => []);
  const key = (pane) => JSON.stringify([pane.id, pane.name, pane.isMainRepo, pane.archived]);
  const missingOnHost = (state.panesBefore ?? []).filter((before) => !panesAfter.some((after) => key(after) === key(before)));
  const newOnHost = panesAfter.filter((after) => !(state.panesBefore ?? []).some((before) => key(before) === key(after)));
  const sidebarAfterReload = await sidebarPanes();
  log(`sidebar after Start + window reload: ${JSON.stringify(sidebarAfterReload)} (a reload also drops Main without Stop/Start: see the control)`);
  // DW2 "same Panes": the host's Panes (id, name, isMainRepo, archived) after Start equal those before Stop.
  check('same-panes', missingOnHost.length === 0 && newOnHost.length === 0,
    `before ${JSON.stringify(state.panesBefore)}; after ${JSON.stringify(panesAfter)}; missing ${JSON.stringify(missingOnHost)}; new ${JSON.stringify(newOnHost)}`);

  const backPanes = await hostPanes().catch(() => []);
  const backPanels = backPanes.find((pane) => pane.id === state.paneId)?.claudePanels ?? [];
  check('same-claude-panel-back', backPanels.length === 1 && backPanels[0].id === state.claudePanelId,
    `Pane ${state.paneId}: ${JSON.stringify(backPanels)} (before Stop: ${state.claudePanelId})`);
  if (!paneBack) {
    await shot('pane-missing');
    return;
  }
  await ui.paneButton(state.paneName).click();
  await page.waitForTimeout(1500);
  // The same panel must be back; the harness never adds a new one here.
  const tabBack = await visible(ui.claudeTab(), 30_000);
  check('claude-tab-back', tabBack, `the Pane's Claude Code tab after Start`);
  if (!tabBack) {
    await shot('claude-tab-missing');
    return;
  }
  await ui.claudeTab().click();
  await page.locator('.xterm:visible').last().waitFor({ timeout: 60_000 });
  const reopened = (await hostPanes()).find((pane) => pane.id === state.paneId)?.claudePanels ?? [];
  check('reopened-same-panel', reopened.length === 1 && reopened[0].id === state.claudePanelId && reopened[0].isActive,
    `active Claude panel of ${state.paneId}: ${JSON.stringify(reopened)}`);
  if (!(reopened.length === 1 && reopened[0].id === state.claudePanelId)) throw new Error('not the Claude panel from before Stop; not prompting');
  await waitClaudeReady(180_000);
  timing('start-to-claude-ready', connectedAt);

  await shot('claude-resumed');
  const transcriptBefore = await transcriptSize().catch(() => undefined);
  const reply = await askClaude('What was the code word I gave you earlier in this conversation? Reply with only WORD= followed by it.', `WORD=${state.codeWord}`);
  results.timings['claude-resumed-answer'] = Math.round(reply.ms / 100) / 10;
  const after = (await hostPanes()).find((pane) => pane.id === state.paneId)?.claudePanels ?? [];
  check('no-panel-added', after.length === 1 && after[0].id === state.claudePanelId, JSON.stringify(after));
  check('claude-resumes-conversation', reply.answered, reply.answered ? `WORD=${state.codeWord} after ${Math.round(reply.ms / 1000)} s` : 'the resumed panel did not recall the code word');
  timing('start-to-resumed-answer', startedAt);
  // The resumed conversation is the one being written: the same panel's transcript grows with this exchange.
  if (!relay) {
    const transcriptAfter = await until(async () => {
      const size = await transcriptSize();
      return size > (transcriptBefore ?? Infinity) ? size : undefined;
    }, 30_000, 3000);
    check('transcript-grows-after-resume', Boolean(transcriptAfter), `${state.claudePanelId}.jsonl ${transcriptBefore} → ${transcriptAfter ?? await transcriptSize().catch(() => undefined)} bytes`);
  }
  await shot('claude-recalled');
}

async function settleAfterDefaultChange() {
  const waitMs = Number(env.DEFAULT_SYNC_WAIT_MS ?? 10_000);
  await page.waitForTimeout(waitMs);
  check('still-connected-after-default-change', await isConnected(state.label), `no reconnect or host switch; waited ${Math.round(waitMs / 1000)} s`);
}

// A new Pane with a Claude panel that has answered once (so its transcript has a model): { paneId, panelId }.
async function newPaneWithClaude(prefix) {
  const paneName = `${prefix}-${crypto.randomBytes(2).toString('hex')}`;
  await ui.newPaneIn(env.REPO).first().click();
  const dialog = page.getByRole('dialog', { name: /^New Pane/ });
  const nameField = dialog.getByPlaceholder('Enter a name for your pane');
  await until(async () => (await nameField.inputValue()) !== '', 10_000, 300);
  await until(async () => {
    if ((await nameField.inputValue()) !== paneName) await nameField.fill(paneName);
    await page.waitForTimeout(700);
    return (await nameField.inputValue()) === paneName;
  }, 15_000, 300);
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await visible(ui.paneButton(paneName), 60_000);
  await page.waitForTimeout(1500);
  await ui.paneButton(paneName).click();
  await page.waitForTimeout(1500);
  const pane = (await hostPanes()).find((entry) => entry.name === paneName);
  check(`${prefix}-pane-id`, Boolean(pane), `Pane "${paneName}" is ${pane?.id} on the host`);
  await ui.addTool().click();
  await ui.claudeTool().click();
  const panel = await until(async () => (await hostPanes()).find((entry) => entry.id === pane.id)?.claudePanels?.[0], 30_000, 1000);
  // The screen helpers follow state.claudePanelId; point them at this panel meanwhile.
  const firstPanel = state.claudePanelId;
  state.claudePanelId = panel?.id;
  try {
    await waitClaudeReady(120_000);
    const a = 100 + crypto.randomInt(800);
    const b = 100 + crypto.randomInt(800);
    const reply = await askClaude(`Compute ${a}+${b} and reply with only SUM= followed by the result.`, `SUM=${a + b}`);
    check(`${prefix}-panel-answers`, reply.answered, reply.answered ? `SUM=${a + b}` : 'no answer');
  } finally {
    state.claudePanelId = firstPanel;
    saveState();
  }
  return { paneId: pane?.id, panelId: panel?.id };
}

// D2 "follows the change": the user changes their default; the sandbox's next new Claude panel runs it.
// A second Pane, so DW2's one-Claude-panel checks on the first Pane stay as they were.
async function phaseModelFollow() {
  // Neither the first default nor the model a host falls back to without one (Sonnet), so only a sandbox that
  // really follows the user's change can pass.
  const next = env.LOCAL_DEFAULT_MODEL_2 ?? 'claude-haiku-4-5-20251001';
  if (next === localDefaultModel()) throw new Error(`LOCAL_DEFAULT_MODEL_2 (${next}) equals the current default`);
  if (/sonnet/i.test(next)) throw new Error(`LOCAL_DEFAULT_MODEL_2 (${next}) is the hosts' fallback model; the check would pass without D2`);
  setLocalDefaultModel(next);
  const changedAt = Date.now();
  // The user just edits their default and keeps working: no reconnect, no host switch (D2 done-when iii as the
  // integrator reads it). A bounded settle time for a debounced watcher, then the next new panel.
  await settleAfterDefaultChange();
  const { panelId, paneId } = await newPaneWithClaude('cs-e2e-follow');
  await checkPanelModel('model-follows-change', panelId, paneId, next);
  timing('default-change-to-followed-answer', changedAt);
  await shot('model-follow');
}

// D2 (ii): no explicit default. Oracle: what local Claude actually uses, asked like the desktop's environment would
// run it (one small real turn; first non-synthetic message.model). The desktop must detect the same and the
// sandbox's next new panel must run it.
function localClaudeActualModel() {
  const run = spawnSync(claudeBin || 'claude', ['-p', 'Reply with only OK.', '--output-format', 'stream-json', '--verbose'], {
    env: appEnv, cwd: home, encoding: 'utf8', timeout: 180_000,
  });
  const lines = String(run.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }).filter(Boolean);
  return {
    reported: lines.find((line) => line.type === 'system' && line.subtype === 'init')?.model,
    actual: lines.map((line) => line.message?.model).find((model) => model && model !== '<synthetic>'),
    status: run.status,
  };
}

async function phaseModelDetect() {
  clearLocalDefaultModel();
  const local = localClaudeActualModel();
  state.localClaudeModel = local;
  saveState();
  check('local-claude-reports-a-model', Boolean(local.actual), `local Claude (no explicit default): init model ${local.reported ?? '?'}, actual ${local.actual ?? '?'} (exit ${local.status})`);
  const detected = fs.existsSync(path.join(out, 'app-main.log'))
    ? (fs.readFileSync(path.join(out, 'app-main.log'), 'utf8').match(/detect[^\n]*?(claude-[a-z0-9.-]+)/gi) ?? []).slice(-3) : [];
  log(`desktop log lines about detection: ${JSON.stringify(detected)}`);
  // The same user steps as model-follow: stay connected, then a new Pane with a Claude panel.
  await settleAfterDefaultChange();
  const { panelId, paneId } = await newPaneWithClaude('cs-e2e-detect');
  await checkPanelModel('model-detected-default', panelId, paneId, local.actual);
  await shot('model-detect');
}

// ---------------------------------------------------------------- D2 (ii): HOME-go (Red, 2026-10-02 5:41 PM PT)
// Desktop B is the side-by-side Linux build of the same commit (PANE_BIN_SBS), run as agentbox's real user (HOME=/home/agent,
// whose ~/.claude has a Max login and no explicit model) with everything else isolated. The side-by-side mode keeps it from
// touching that HOME's MCP config, skills, autostart and pane:// handler; its own data dir is /home/agent/.pane_cloudsandbox,
// staged with copies of desktop A's saved host and cloud credentials and deleted afterwards. The login is never copied; the
// only Claude run against it is the offline probe (dead proxy, as the library's), so no request leaves and no token refreshes.
const realClaudeDir = path.join(realHome, '.claude');
const homeGoDataDir = path.join(realHome, '.pane_cloudsandbox');
const sha256 = (value) => crypto.createHash('sha256').update(value ?? '').digest('hex').slice(0, 16);
const fileHash = (file) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : 'absent');
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// What must not change under the real HOME (hashes and names only; ~/.claude.json itself is rewritten by every running
// Claude, so only its mcpServers part is compared).
function homeSnapshot() {
  let mcp = 'absent';
  try {
    mcp = sha256(JSON.stringify(JSON.parse(fs.readFileSync(path.join(realHome, '.claude.json'), 'utf8')).mcpServers ?? null));
  } catch {
    // Mid-rewrite by another Claude: compared again below.
  }
  return {
    claudeJsonMcpServers: mcp,
    claudeSettings: fileHash(path.join(realClaudeDir, 'settings.json')),
    claudeCredentials: fileHash(path.join(realClaudeDir, '.credentials.json')),
    claudeSkills: listing(path.join(realClaudeDir, 'skills')),
    agentsSkills: listing(path.join(realHome, '.agents', 'skills')),
    codexConfig: fileHash(path.join(realHome, '.codex', 'config.toml')),
    cursorMcp: fileHash(path.join(realHome, '.cursor', 'mcp.json')),
    autostart: listing(path.join(realHome, '.config', 'autostart')),
    applications: listing(path.join(realHome, '.local', 'share', 'applications')),
    mimeapps: fileHash(path.join(realHome, '.config', 'mimeapps.list')),
  };
}

// The oracle: the library's own offline probe, run here as agentbox's user: `claude -p` with every proxy at a closed port,
// one placeholder message, the model on Claude's system/init line, then killed; its empty project folder is removed.
async function offlineProbeModel() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-probe-'));
  const probeEnv = { PATH: basePath, HOME: realHome, USER: os.userInfo().username, LANG: env.LANG ?? 'C.UTF-8' };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) probeEnv[name] = 'http://127.0.0.1:9';
  const child = spawn(claudeBin || 'claude', ['-p', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    { env: probeEnv, cwd, detached: true });
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })}\n`);
  const model = await new Promise((resolve) => {
    let buffer = '';
    const done = (value) => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'system' && parsed.subtype === 'init') done(parsed.model ?? null);
        } catch {
          // Not a whole JSON line yet.
        }
      }
    });
    child.on('close', () => done(null));
    setTimeout(() => done(null), 15_000);
  });
  // As the library does: only folders named after the probe's temp dir that hold no file.
  const projects = path.join(realClaudeDir, 'projects');
  const hasFile = (dir) => fs.readdirSync(dir, { recursive: true }).some((entry) => fs.statSync(path.join(dir, String(entry))).isFile());
  for (const entry of listing(projects).filter((name) => name.endsWith(path.basename(cwd)))) {
    if (!hasFile(path.join(projects, entry))) fs.rmSync(path.join(projects, entry), { recursive: true, force: true });
  }
  fs.rmSync(cwd, { recursive: true, force: true });
  return model;
}

function removeHomeGoDataDir() {
  if (!fs.existsSync(homeGoDataDir)) return;
  const config = path.join(homeGoDataDir, 'config.json');
  if (fs.existsSync(config)) spawnSync('shred', ['-u', config]);
  fs.rmSync(homeGoDataDir, { recursive: true, force: true });
  log(`deleted ${homeGoDataDir}`);
}

async function phaseHomeDetect() {
  if (realHome !== '/home/agent') throw new Error('home-detect: runs only on agentbox as /home/agent');
  if (fs.existsSync(homeGoDataDir)) throw new Error(`home-detect: ${homeGoDataDir} exists already; not touching it`);
  let realSettingsModel;
  try {
    realSettingsModel = JSON.parse(fs.readFileSync(path.join(realClaudeDir, 'settings.json'), 'utf8')).model;
  } catch {
    realSettingsModel = undefined;
  }
  if (realSettingsModel) throw new Error('home-detect: /home/agent has an explicit model; (ii) needs none');
  const before = homeSnapshot();
  const expected = env.HOME_EXPECTED_MODEL ?? 'claude-opus-5-5';

  // Oracle first, as agentbox's user, offline.
  const probed = await offlineProbeModel();
  state.homeGoProbe = probed;
  saveState();
  check('home-probe-init-model', probed === expected, `offline probe as /home/agent (no explicit default): init model ${probed ?? 'none'}; expected ${expected}`);

  // Desktop A off; desktop B on, staged with copies of A's saved host and cloud credentials (shredded/deleted after).
  const desktopADir = paneDir;
  await closeApp();
  const cloudDirB = path.join(work, 'home-go', 'runpane-cloud');
  fs.mkdirSync(path.dirname(cloudDirB), { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(home, '.config', 'runpane-cloud'))) fs.cpSync(path.join(home, '.config', 'runpane-cloud'), cloudDirB, { recursive: true });
  else fs.mkdirSync(cloudDirB, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeGoDataDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(desktopADir, 'config.json'), path.join(homeGoDataDir, 'config.json'));
  fs.chmodSync(path.join(homeGoDataDir, 'config.json'), 0o600);
  state.homeGoStaged = true;
  saveState();
  const isolated = path.join(work, 'home-go');
  const envB = {
    PATH: basePath,
    HOME: realHome,
    USER: os.userInfo().username,
    LANG: env.LANG ?? 'C.UTF-8',
    DISPLAY: env.DISPLAY ?? '',
    XAUTHORITY: env.XAUTHORITY ?? '',
    XDG_CONFIG_HOME: path.join(isolated, 'config'),
    XDG_DATA_HOME: path.join(isolated, 'data'),
    XDG_CACHE_HOME: path.join(isolated, 'cache'),
    XDG_STATE_HOME: path.join(isolated, 'state'),
    XDG_RUNTIME_DIR: path.join(work, 'run'),
    RUNPANE_CLOUD_DIR: cloudDirB,
  };
  paneDir = homeGoDataDir;
  let panel;
  try {
    // No trace: desktop B runs on a real user's HOME.
    await launch({ bin: path.resolve(env.PANE_BIN_SBS), launchEnv: envB, trace: false });
    await shot('home-go-launched');
    // Picking the sandbox connects; the desktop syncs its default to a running cloud sandbox on connect.
    const connectedAt = Date.now();
    check('home-go-connected', await connectTo(state.label, 90_000), `desktop B (HOME=/home/agent) → ${state.label}`);
    await page.waitForTimeout(Number(env.DEFAULT_SYNC_WAIT_MS ?? 10_000));
    const synced = await syncedModelOnSandbox();
    check('home-go-detected-and-sent', synced === probed, `the sandbox's synced default (marker) ${synced ?? 'none'}; offline probe ${probed ?? 'none'}`);
    panel = await newPaneWithClaude('cs-e2e-home');
    const actual = await panelModel(panel.panelId, panel.paneId).catch(() => undefined);
    check('model-detected-default-home', actual === probed && actual === expected,
      `new sandbox panel ${panel.panelId} ran ${actual ?? 'unknown'}; local Claude (probe) ${probed ?? 'none'}; expected ${expected} (Sonnet without D2; the sandbox held ${env.LOCAL_DEFAULT_MODEL_2 ?? 'claude-haiku-4-5-20251001'} from (iii))`);
    timing('home-go-connect-to-checked', connectedAt);
    await shot('home-go-panel');
  } finally {
    await closeApp();
    paneDir = desktopADir;
    removeHomeGoDataDir();
    spawnSync('find', [cloudDirB, '-type', 'f', '-exec', 'shred', '-u', '{}', '+']);
    fs.rmSync(path.join(work, 'home-go'), { recursive: true, force: true });
    state.homeGoStaged = false;
    saveState();
    await launch();
  }
  const after = homeSnapshot();
  const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  check('home-agent-unchanged', changed.length === 0 && !fs.existsSync(homeGoDataDir),
    `changed under /home/agent: ${JSON.stringify(changed)} (login file hash ${before.claudeCredentials === after.claudeCredentials ? 'unchanged: no refresh' : 'CHANGED'}); ${homeGoDataDir} ${fs.existsSync(homeGoDataDir) ? 'still there' : 'deleted'}`);
}

// The default the desktop last synced to the sandbox: the library's marker file there, read through a probe panel.
async function syncedModelOnSandbox() {
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  const token = savedHostToken(paneDir, host.id);
  const marker = `CSE2E_SYNCED_${crypto.randomBytes(3).toString('hex')}`;
  const created = await daemonInvoke(host.baseUrl, token, 'runpane:panels:create', {
    paneId: state.paneId, type: 'terminal', noFocus: true,
    tool: { title: 'cs-e2e synced-model probe', command: `echo ${marker}=$(cat ~/.runpane-cloud/claude-model 2>/dev/null | head -1)` },
  });
  const probe = created?.panelId ?? created?.panel?.id;
  return until(async () => {
    const screen = await daemonInvoke(host.baseUrl, token, 'runpane:panels:screen', { panelId: probe, limit: 40 });
    fs.writeFileSync(path.join(out, 'synced-marker-screen.txt'), redact(String(screen?.text ?? '')));
    // The panel also shows the typed command, after the prompt and possibly wrapped right after `…=`; the output is
    // the line that STARTS with the marker.
    const value = String(screen?.text ?? '').match(new RegExp(`^${marker}=(claude-[A-Za-z0-9._\\[\\]-]+|)[ \\t]*$`, 'm'))?.[1];
    return value === undefined ? undefined : value || null;
  }, 20_000, 1000);
}

async function phaseRemove() {
  const startedAt = Date.now();
  if (mode === 'fake') {
    await openConnections();
    await page.getByRole('button', { name: `Delete ${state.label}` }).click();
    await page.waitForTimeout(1500);
    fakeDaemonKill();
  } else {
    await openCloud();
    await ui.rowAction('Remove', state.label).click();
    const confirm = ui.confirmDialog(state.label);
    check('remove-asks-first', await visible(confirm, 3000), `dialog "Remove ${state.label}?"`);
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
    const gone = await until(async () => !(await visible(ui.row(state.label), 500)), 300_000, 2000);
    timing('remove', startedAt);
    check('row-gone', Boolean(gone), state.label);
    if (!relay) {
      const sandbox = await until(async () => {
        const answer = await boatSandbox(state.cloud.sandboxId, boatOrg);
        return answer.exists ? undefined : answer;
      }, 120_000, 5000);
      check('boat-sandbox-gone', Boolean(sandbox), `boat: ${JSON.stringify(sandbox ?? await boatSandbox(state.cloud.sandboxId, boatOrg))}`);
      const devices = await tailnetDevices(state.cloud.hostname);
      check('tailnet-device-gone', devices.length === 0, JSON.stringify(devices));
    }
  }
  const left = savedHosts(paneDir).filter((entry) => entry.label === state.label);
  check('saved-host-removed', left.length === 0, JSON.stringify(left));
  // Removed as far as the app goes; what follows only checks the switcher.
  if (left.length === 0) {
    state.removed = true;
    saveState();
  }
  // With no saved remote host left the app shows no host switcher at all (SOBECK Run 6: nothing else was saved).
  await closeSettings();
  if (!(await visible(ui.switcherChip(), 5000))) {
    check('switcher-no-longer-lists', true, `no host switcher at all: no remote host is saved any more, so ${state.label} isn't listed`);
  } else {
    await openSwitcher();
    check('switcher-no-longer-lists', !(await visible(ui.hostItem(state.label), 2000)), state.label);
  }
  await closeMenus();
  await shot('removed');
  state.removed = true;
  saveState();
}

async function phaseHygiene() {
  if (relay) {
    const now = savedHosts(paneDir).map((host) => ({ ...host, tokenSha256: crypto.createHash('sha256').update(savedHostToken(paneDir, host.id) ?? '').digest('hex') }));
    const changed = state.existingHosts.filter((before) => JSON.stringify(now.find((host) => host.id === before.id)) !== JSON.stringify(before));
    check('existing-hosts-unchanged', changed.length === 0, `${state.existingHosts.length} saved before the run (${state.existingHosts.map((host) => host.label).join(', ')}); changed: ${JSON.stringify(changed.map((host) => host.label))}`);
  }
  const existing = state.existingRemote && savedHosts(paneDir).find((entry) => entry.id === state.existingRemote.id);
  const token = state.existingRemote && savedHostToken(paneDir, state.existingRemote.id);
  if (state.existingRemote) check('existing-remote-unchanged', existing?.label === state.existingRemote.label && existing?.baseUrl === state.existingRemote.baseUrl && token === state.existingRemote.token,
    JSON.stringify(existing ?? null));
  await closeSettings();
  if (!(await visible(ui.switcherChip(), 5000))) {
    // No switcher means no remote host: the app can only be on This computer. Its local sidebar must be there.
    const local = await visible(page.getByRole('button', { name: 'Add repository' }), 15_000);
    check('local-runtime-works', local, 'no remote host saved: the app runs on This computer (no host switcher shown)');
  } else {
    await openSwitcher();
    await ui.localItem().click();
    const local = await visible(page.getByRole('button', { name: /This computer.*Switch host|Agents run on this computer/i }), 15_000);
    check('local-runtime-works', local, 'switched back to This computer');
  }
  await shot('back-on-local');
}

// ---------------------------------------------------------------- run
const started = Date.now();
// An interrupted run still stops the fake host it started.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (mode === 'fake') fakeDaemonKill();
    process.exit(130);
  });
}
try {
  if (mode === 'fake' && state.fakePid === undefined && phases.includes('start') && !phases.includes('add') && !phases.includes('stop')) {
    throw new Error('fake start needs a stopped fake host from an earlier stop phase');
  }
  await launch();
  await shot('launched');
  const run = { credentials: phaseCredentials, add: phaseAdd, agent: phaseAgent, stop: phaseStop, start: phaseStart, 'model-follow': phaseModelFollow, 'model-detect': phaseModelDetect, 'home-detect': phaseHomeDetect, remove: phaseRemove, hygiene: phaseHygiene };
  for (const phase of phases) {
    log(`== phase ${phase}`);
    const phaseStartedAt = Date.now();
    await run[phase]();
    timing(`phase-${phase}`, phaseStartedAt);
  }
} catch (error) {
  check('run-completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  if (page) await shot('error');
  // Never leave a sandbox behind: a failed live run still removes what it created, through the app.
  if (mode !== 'fake' && state.cloud && !state.removed && page) {
    log('cleanup: removing the sandbox after the failure');
    await phaseRemove().catch((cleanupError) => {
      const reason = cleanupError instanceof Error ? cleanupError.message.split('\n')[0] : String(cleanupError);
      // A failure after the app removed the sandbox is a UI check, not a sandbox left behind.
      check('cleanup-remove', state.removed === true, state.removed ? `sandbox removed; a later UI check failed: ${reason}` : `${reason}; remove ${state.cloud.sandboxId} by hand`);
    });
  }
} finally {
  if (state.homeGoStaged) removeHomeGoDataDir();
  if (context && tracing) await context.tracing.stopChunk({ path: path.join(out, `trace-${String(++traceChunk).padStart(2, '0')}.zip`) }).catch(() => undefined);
  if (context && tracing) await context.tracing.stop().catch(() => undefined);
  await app?.close().catch(() => undefined);
  if (mode === 'fake' && phases.at(-1) !== 'stop') fakeDaemonKill();
  saveState();
  // No secret value in anything the run wrote or the app logged (traces are zips: unzipped to search them).
  const unzipped = path.join(work, 'trace-unzipped');
  fs.rmSync(unzipped, { recursive: true, force: true });
  for (const trace of fs.readdirSync(out).filter((name) => name.endsWith('.zip'))) {
    fs.mkdirSync(path.join(unzipped, trace), { recursive: true });
    if (windows) spawnSync('tar', ['-xf', path.join(out, trace), '-C', path.join(unzipped, trace)]);
    else spawnSync('unzip', ['-qo', path.join(out, trace), '-d', path.join(unzipped, trace)]);
  }
  // K6: nothing this run created may be left, whatever happened above (a failed Add removes its own sandbox).
  if (mode === 'live') {
    const left = await boatSandboxes(boatOrg).then((all) => all.filter((sandbox) => /^rp-loop-cs-/.test(sandbox.name)), () => undefined);
    check('no-leftover-sandboxes', Array.isArray(left) && left.length === 0, left ? `rp-loop-cs-* in the test wallet: ${JSON.stringify(left)}` : 'boat listing failed');
  }
  const scanned = scanForSecrets([out, unzipped, path.join(paneDir, 'logs'), path.join(home, '.config/Pane/logs')].filter((root) => fs.existsSync(root)));
  check('no-secret-in-evidence-or-logs', scanned.hits.length === 0,
    `${secretNames().length} values searched in ${scanned.files} files${scanned.hits.length ? `; found in ${scanned.hits.map((hit) => `${hit.file.replace(work, '$WORK')} (${hit.names.join(',')})`).join('; ')}` : ''}`);
  results.ok = results.checks.every((entry) => entry.verdict !== 'FAIL');
  results.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  log(results.ok ? 'RESULT PASS' : 'RESULT FAIL');
  process.exitCode = results.ok ? 0 : 1;
}
