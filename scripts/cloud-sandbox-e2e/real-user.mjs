#!/usr/bin/env node
// Real-user repo flow (design brief "real-user repo flow", done-when D0–D9): drives the Pane desktop window with
// Playwright, clicking and typing exactly what a user does, with one video of the whole run and a screenshot of
// every step's visible result. Reads through the host's own API (/invoke, panels:screen) are ORACLES only: each
// is saved as <shot>.oracle.json next to the screenshot that shows the same result in the window.
//
// Order (brief): D0, D1, D3 (negative, before sign-in), D2, D4, D5, D6, D7, D8, D9.
//   MODE=relay  SOBECK: the installed side-by-side test build, Red's credentials in it, 2 test-wallet starts,
//               pauses for Red's two device sign-ins (flag files in FLAG_DIR).
//   MODE=live   Linux test-org rehearsal (agentbox, xvfb): D0 D1 D3 D4 (public repo) D5 D6 (Claude) D7 D9.
//   MODE=fake   Self-hosted remote, 0 starts: a second headless daemon of the same build on loopback, saved as a
//               plain remote host. D1 D3 D4 D5 D6 (Claude) D9; the cloud-only steps are SKIP.
// STEPS=D1,D3 runs a subset (D9 cleanup always runs unless NO_REMOVE=1).
import { _electron as electron } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSecret, loadSecret, redact, scanForSecrets, scanForTokenShapes, secretNames, secretValue, tokenShapes } from './secrets.mjs';
import { boatSandbox, daemonInvoke, health, savedHostToken, savedHosts, tailnetDevices } from './oracles.mjs';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`real-user: set ${name}`);
  return env[name];
};
const mode = ['fake', 'relay'].includes(env.MODE) ? env.MODE : 'live';
const relay = mode === 'relay';
const cloud = mode !== 'fake';
const windows = process.platform === 'win32';
const realHome = os.homedir();
const paneBin = path.resolve(required('PANE_BIN'));
const work = path.resolve(required('WORK'));
const out = path.resolve(required('OUT'));
const home = relay ? realHome : path.join(work, 'home');
const paneDir = relay ? path.resolve(required('PANE_DATA_DIR'))
  : env.SIDE_BY_SIDE_NAME ? path.join(home, `.pane_${env.SIDE_BY_SIDE_NAME}`) : path.join(home, '.pane');
for (const forbidden of [path.join(realHome, '.pane'), path.join(realHome, '.pane_remote'), path.join(realHome, '.pane_cloudtest')]) {
  if (paneDir.toLowerCase() === forbidden.toLowerCase()) throw new Error(`real-user: refusing to use ${forbidden}`);
}
if (paneBin.startsWith('/opt/') || paneBin === '/usr/bin/pane' || /[\\/]Programs[\\/]Pane[\\/]/i.test(paneBin)) {
  throw new Error('real-user: PANE_BIN must be the test build, never the installed Pane');
}
const boatOrg = env.BOAT_ORG ?? 'test';
if (mode === 'live' && boatOrg !== 'test') throw new Error('real-user: live runs use the boat test org only');
// Red's own sandbox: never selected, read, stopped or removed. Every host filter excludes it.
const HANDS_OFF = new Set(['testina', ...(env.HANDS_OFF_LABELS ?? '').split(',').filter(Boolean)]);
const flagDir = path.resolve(env.FLAG_DIR ?? path.join(work, 'flags'));
const secretsDir = env.SECRETS_DIR ?? path.join(realHome, 'rc-loop/secrets');
const maxStarts = Number(env.MAX_STARTS ?? 2);
const startsLog = env.STARTS_LOG ?? (relay ? path.join(out, 'starts.txt') : path.join(realHome, 'rc-loop/evidence/cs-e2e/starts-real.txt'));

const now = new Date();
const stamp = `${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
// The repo every user clones (private, so an unsigned host fails D3). Rehearsals clone a public one in D4.
const PRIVATE_REPO = env.PRIVATE_REPO_URL ?? 'https://github.com/jamari-morrison/montlakev2';
const cloneUrl = env.REPO_URL ?? (relay ? PRIVATE_REPO : 'https://github.com/octocat/Hello-World');
const repoName = cloneUrl.replace(/\.git$/, '').split('/').pop();
// A second repo the user puts on the host from its terminal, then opens with the remote picker (D4c).
const OPEN_REPO_URL = env.OPEN_REPO_URL ?? 'https://github.com/octocat/Spoon-Knife';
const openRepoDir = 'e2e-open-repo';
const prRepo = env.PR_REPO ?? 'jamari-morrison/montlakev2';
const prBranch = `e2e/${stamp}`;
const WINDOWS_PATH = String.raw`C:\runpane-temp-home\montlakev2`;
const GH_PREFILL = 'gh auth login --web --git-protocol https && gh auth setup-git';
const MARKER = 'E2E_MARKER';
const STARTUP_MARKER_LOG = '~/e2e-startup-marker.log';
const startupScript = `# cs-e2e marker (Run 8): one line per run\necho "${MARKER} $(date -Is)" >> ${STARTUP_MARKER_LOG}\necho ${MARKER}\n`;

const allSteps = ['D0', 'D1', 'D3', 'D2', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'];
const wanted = new Set(env.STEPS ? env.STEPS.split(',') : allSteps);
if (env.NO_REMOVE !== '1') wanted.add('D9');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(paneDir, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- state, log, steps
const statePath = path.join(work, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const saveState = () => fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const results = { kit: 'real-user', mode, stamp, ...(env.RUN_NOTE ? { note: env.RUN_NOTE } : {}), steps: [], checks: [], findings: [], regression: [], prUrl: null, video: [] };
const writeResults = () => fs.writeFileSync(path.join(out, 'results.json'), `${redact(JSON.stringify(results, null, 2))}\n`);
const log = (...parts) => {
  const line = redact(`${new Date().toISOString()} ${parts.join(' ')}`);
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
let current; // the running step
const check = (name, ok, detail = '') => {
  const entry = { step: current?.id ?? null, name, verdict: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail: redact(detail) };
  results.checks.push(entry);
  current?.checks.push(entry);
  log(entry.verdict, current?.id ?? '-', name, detail);
  return ok;
};
const finding = (text) => {
  results.findings.push(redact(text));
  log('FINDING', text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeoutMs, everyMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(everyMs);
  }
};

function countStart(what) {
  fs.mkdirSync(path.dirname(startsLog), { recursive: true });
  const used = fs.existsSync(startsLog) ? fs.readFileSync(startsLog, 'utf8').split('\n').filter(Boolean).length : 0;
  if (used >= maxStarts) throw new Error(`start budget used (${used}/${maxStarts} in ${startsLog})`);
  fs.appendFileSync(startsLog, `${new Date().toISOString()} ${what} ${state.label ?? ''}\n`);
  log(`boat start ${used + 1}/${maxStarts}: ${what}`);
}

// ---------------------------------------------------------------- secrets (names only in any output)
if (mode === 'live') {
  loadSecret('boatApiKey', path.join(secretsDir, 'boat.hdr'), (text) => text.trim().replace(/^Authorization: Bearer /, ''));
  loadSecret('tailscaleClientSecret', path.join(secretsDir, 'TAILSCALE_OAUTH_SECRET'));
  addSecret('tailscaleClientId', env.TAILSCALE_CLIENT_ID ?? 'krreHuCr3M11CNTRL');
}
if (relay) {
  // The credentials Red saved in this build, registered so every log and evidence file is searched for them.
  const credentialsFile = path.join(env.RUNPANE_CLOUD_DIR ?? path.join(env.XDG_CONFIG_HOME ?? path.join(realHome, '.config'), 'runpane-cloud'), 'credentials.json');
  const register = (value, keyPath) => {
    if (typeof value === 'string' && value.length >= 16) addSecret(`cloudCredential:${keyPath}`, value);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) register(child, `${keyPath}.${key}`);
  };
  try {
    register(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')), 'credentials');
  } catch {
    // None saved yet: D0 reports it.
  }
} else if (env.FAKE_CLAUDE !== '1') {
  const claudeSlot = fs.readFileSync(path.join(secretsDir, 'claude-slot'), 'utf8').trim();
  loadSecret('claudeToken', path.join(secretsDir, claudeSlot));
}
for (const host of savedHosts(paneDir)) addSecret(`savedHostToken:${host.label}`, savedHostToken(paneDir, host.id));
log(`secrets loaded (names only): ${secretNames().join(', ')}`);

// ---------------------------------------------------------------- environment
const relayEnv = () => Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() === 'ANTHROPIC_MODEL'
  || !/^(PANE_|RUNPANE_|ELECTRON_RUN_AS_NODE$|CLAUDE_CODE_OAUTH_TOKEN$|ANTHROPIC_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(name)));
const claudeBin = relay || windows ? '' : (spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout ?? '').trim();
const basePath = [...new Set([path.dirname(process.execPath), claudeBin ? path.dirname(claudeBin) : '', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':');
function cleanEnv(extra) {
  if (windows) {
    return { ...relayEnv(), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ...extra };
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
const debEnv = env.PANE_DEB_URL ? { RUNPANE_CLOUD_PANE_DEB_URL: env.PANE_DEB_URL, RUNPANE_CLOUD_PANE_DEB_SHA256: env.PANE_DEB_SHA256 ?? '' } : {};
const appEnv = relay
  ? { ...relayEnv(), ...debEnv, RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs' }
  : cleanEnv({ PANE_DIR: paneDir, ...debEnv, ...(mode === 'live' ? { RUNPANE_CLOUD_BOAT_ORG: boatOrg, RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs' } : {}) });

// ---------------------------------------------------------------- the self-hosted remote (MODE=fake)
// A short home like a sandbox's /home/user: a long one wraps every terminal row the checks read (DROP 1 proof).
const fakeHome = env.FAKE_HOME ?? (windows ? path.join(work, 'fh') : path.join(os.tmpdir(), `cse2e-${path.basename(work).slice(-6)}`));
const fakeDir = path.join(fakeHome, '.pane');
const fakePort = Number(env.FAKE_PORT ?? 42198);
const fakeBaseUrl = `http://127.0.0.1:${fakePort}`;
const fakeLabel = env.FAKE_LABEL ?? 'agentbox-selfhosted';
const fakeBin = path.join(fakeHome, 'bin');
const fakeEnv = () => {
  const base = cleanEnv({
    HOME: fakeHome,
    ...(windows
      ? { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') }
      : { XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_DATA_HOME: path.join(fakeHome, '.local/share'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'), DISPLAY: '' }),
    // A signed-in Claude like a provisioned host; never a GitHub or Codex credential.
    ...(env.FAKE_CLAUDE === '1' ? {} : { CLAUDE_CODE_OAUTH_TOKEN: secretValue('claudeToken') }),
    CLAUDE_CODE_SANDBOXED: '1',
    // No credential prompt of any kind, as on a host nobody is watching (a sandbox behaves the same).
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) delete base[name];
  if (env.FAKE_CLAUDE === '1') {
    // The stand-in first on PATH, whatever case the PATH variable has (Windows spells it Path).
    const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const value = base[key] ?? '';
    delete base[key];
    base.PATH = `${fakeBin}${path.delimiter}${value}`;
  }
  return base;
};
function installFakeClaude() {
  fs.mkdirSync(fakeBin, { recursive: true });
  const script = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  finding('FAKE_CLAUDE=1: the self-hosted host runs a Claude stand-in (fake-claude.mjs), not Claude Code');
}

function fakeSetup() {
  fs.mkdirSync(fakeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), `${JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects: { [fakeHome]: { hasTrustDialogAccepted: true } } })}\n`, { mode: 0o600 });
  // A plain host has a git identity of its own (the user's); without one a new project's first commit fails.
  fs.writeFileSync(path.join(fakeHome, '.gitconfig'), '[user]\n\tname = cs-e2e\n\temail = cs-e2e@localhost\n');
  if (env.FAKE_CLAUDE === '1') installFakeClaude();
  const setup = spawnSync(paneBin, ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox', '--remote-setup', '--label', fakeLabel, '--pane-dir', fakeDir,
    '--listen-port', String(fakePort), '--prefer-tunnel', 'manual', '--base-url', fakeBaseUrl, '--no-install-service'], { env: fakeEnv(), encoding: 'utf8', timeout: 120_000 });
  const code = (setup.stdout ?? '').match(/pane-remote:\/\/[A-Za-z0-9_-]+/)?.[0];
  if (setup.status !== 0 || !code) throw new Error(`self-hosted host: --remote-setup exited ${setup.status} without a code`);
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
}
function fakeDaemonKill() {
  if (!state.fakePid) return;
  if (windows) {
    spawnSync('taskkill', ['/PID', String(state.fakePid), '/T', '/F']);
    delete state.fakePid;
    saveState();
    return;
  }
  try {
    process.kill(-state.fakePid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  delete state.fakePid;
  saveState();
}
// Saved like a host paired through "Add remote host" (no cloud field, no host kind: a self-hosted remote).
function fakeSaveHost(payload) {
  const configPath = path.join(paneDir, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  config.remoteDaemon = { ...config.remoteDaemon, client: { profiles: [], activeProfileId: null, mode: 'local', ...config.remoteDaemon?.client } };
  config.remoteDaemon.client.profiles = [...config.remoteDaemon.client.profiles.filter((profile) => profile.label !== payload.label),
    { id: crypto.randomUUID(), label: payload.label, baseUrl: fakeBaseUrl, token: payload.token, transport: 'http+sse' }];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------- app, video, evidence
let app;
let page;
let videoStartedAt = 0;
let shotIndex = 0;

async function launch({ video = true } = {}) {
  app = await electron.launch({
    executablePath: paneBin,
    args: windows ? [] : ['--no-sandbox'],
    env: appEnv,
    timeout: 120_000,
    // One recording of the whole run; no Playwright trace (it would record the launch environment).
    ...(video ? { recordVideo: { dir: path.join(out, 'video'), size: { width: 1440, height: 900 } } } : {}),
  });
  const mainLog = path.join(out, 'app-main.log');
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk) => fs.appendFileSync(mainLog, redact(chunk.toString())));
  page = await app.firstWindow();
  if (video) videoStartedAt = Date.now();
  page.on('console', (message) => fs.appendFileSync(path.join(out, 'app-console.log'), `${redact(`[${message.type()}] ${message.text()}`)}\n`));
  await page.waitForLoadState('domcontentloaded');
  if (!windows) await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await sleep(4000);
  // Observers in the main process (they change nothing a user sees): which URLs a click handed to the browser, and
  // whether the native folder dialog was asked for (it is answered "cancel", like a user closing it; a native dialog
  // can't be driven from here).
  await app.evaluate(({ shell, dialog }, openForReal) => {
    globalThis.__e2eOpened = [];
    globalThis.__e2eNativeDialogs = [];
    const openExternal = shell.openExternal.bind(shell);
    shell.openExternal = (url, options) => {
      globalThis.__e2eOpened.push(String(url));
      return openForReal ? openExternal(url, options) : Promise.resolve();
    };
    dialog.showOpenDialog = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === 'object' && 'properties' in arg) ?? {};
      globalThis.__e2eNativeDialogs.push({ properties: options.properties ?? [], title: options.title ?? '' });
      return { canceled: true, filePaths: [] };
    };
  }, relay);
  await dismissFirstRun();
}
async function closeApp() {
  const video = page?.video();
  await app?.close().catch(() => undefined);
  if (video) results.video.push(path.relative(out, await video.path().catch(() => '')));
  app = undefined;
}
const videoAt = () => (videoStartedAt ? Math.round((Date.now() - videoStartedAt) / 100) / 10 : null);

// A screenshot of the window, its accessibility snapshot and (when given) the oracle read that decided the check,
// all secret-scanned before they are written. `result: true` marks the shot that shows the step's result.
async function shot(what, { oracle, result = false } = {}) {
  const base = path.join(out, `${String(++shotIndex).padStart(3, '0')}-${current?.id ?? 'setup'}-${what}`);
  await page.screenshot({ path: `${base}.png` }).catch(() => undefined);
  const aria = redact(await page.locator('body').ariaSnapshot().catch(() => ''));
  fs.writeFileSync(`${base}.aria.yml`, aria);
  const entry = { file: path.basename(`${base}.png`), videoAt: videoAt(), result };
  if (oracle !== undefined) {
    const text = redact(JSON.stringify(oracle, null, 2));
    fs.writeFileSync(`${base}.oracle.json`, `${text}\n`);
    entry.oracle = path.basename(`${base}.oracle.json`);
  }
  const shapes = [...new Set([...tokenShapes(aria), ...(oracle === undefined ? [] : tokenShapes(JSON.stringify(oracle)))])];
  if (shapes.length > 0) check(`no-token-on-screen:${what}`, false, `token shapes in the window or its oracle: ${shapes.join(', ')}`);
  current?.shots.push(entry);
  log('SHOT', entry.file, `video ${entry.videoAt ?? '-'} s`);
}

async function step(id, title, run, { applies = true, why = '' } = {}) {
  if (!wanted.has(id)) return;
  current = { id, title, verdict: 'SKIP', startedAtVideo: videoAt(), shots: [], checks: [], error: null, ...(env.RUN_NOTE ? { note: env.RUN_NOTE } : {}) };
  results.steps.push(current);
  log(`== ${id} ${title}`);
  if (!applies) {
    current.error = why;
    log('SKIP', id, why);
    current = undefined;
    writeResults();
    return;
  }
  try {
    await run();
  } catch (error) {
    current.error = redact(error instanceof Error ? error.message : String(error));
    log('ERROR', id, current.error);
    await shot('error');
    // A dialog or menu left open by the failure would hide the rest of the window from the next step.
    for (let round = 0; round < 3; round++) await closeMenus();
  }
  const failed = current.error || current.checks.some((entry) => entry.verdict === 'FAIL');
  // A7: no screenshot of the result in the window, no MET.
  const shown = current.shots.some((entry) => entry.result);
  if (!failed && !shown) check('result-visible-in-window', false, 'no screenshot shows this step\'s result');
  current.verdict = failed || !shown ? 'FAIL' : 'PASS';
  current.endedAtVideo = videoAt();
  log(`== ${id} ${current.verdict}`);
  current = undefined;
  writeResults();
}

// ---------------------------------------------------------------- UI map (role + accessible name / visible text only)
// Names as agreed in ~/rc-loop/ledger/iface-real.md (cs-e2e kit contract v2 and the owners' AGREE notes).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ui = {
  dialog: (name) => page.getByRole('dialog', { name }),
  home: () => page.getByRole('button', { name: 'Home', exact: true }).first(),
  homeCard: (name) => page.getByRole('button', { name, exact: true }),
  addRepositoryFooter: () => page.getByRole('button', { name: '+ Add Repository' }),
  switcherChip: () => page.getByRole('button', { name: /Switch host$/ }).first(),
  connectedChip: (label) => page.getByRole('button', { name: `Agents run on ${label}. Switch host` }),
  hostItem: (label) => page.getByRole('menuitemradio', { name: new RegExp(escapeRegExp(label)) }),
  localItem: () => page.getByRole('menuitemradio', { name: /This computer/ }),
  manageConnections: () => page.getByRole('button', { name: /Manage connections/ }),
  // The switcher's entry is a menu item; the cloud sandbox row's is a button (same name, cs-host-terminal v2 C).
  switcherTerminal: (label) => page.getByRole('menuitem', { name: `Open terminal on ${label}`, exact: true }),
  rowOpenTerminal: (label) => ui.row(label).getByRole('button', { name: `Open terminal on ${label}`, exact: true }),
  hostTerminalTab: (label) => page.getByRole('tab', { name: new RegExp(`${escapeRegExp(label)} · Terminal`) }),
  // The terminal's name, "Terminal on <host>", labels its tab strip.
  hostTerminalHeading: (label) => page.getByRole('tablist', { name: `Terminal on ${label}`, exact: true }),
  hostChip: (scope, label, kind) => scope.getByText(label ? `On: ${label} (${kind})` : 'On: This computer', { exact: true }),
  // Folder browser (cs-repo-ui HostFolderBrowser): a click on an entry opens it; "Select this folder" picks the current one.
  picker: (label) => page.getByRole('dialog', { name: new RegExp(`^Choose a folder on ${escapeRegExp(label)}`) }),
  pickerCurrent: (picker) => picker.getByLabel('Current folder'),
  pickerEntry: (picker, name, isGitRepo) => picker.getByRole('button', { name: isGitRepo ? `${name}, git repo` : name, exact: true }),
  pickerNewFolder: (picker) => picker.getByRole('button', { name: /^New folder/ }),
  pickerConfirm: (picker) => picker.getByRole('button', { name: 'Select this folder', exact: true }),
  signInAlert: (scope, label) => scope.getByRole('alert').filter({ hasText: `${label} isn't signed in to GitHub.` }),
  signInOpenTerminal: (label) => page.getByRole('button', { name: `Open terminal on ${label} to sign in`, exact: true }),
  tryAgain: () => page.getByRole('button', { name: 'Try again', exact: true }),
  settingsButton: () => page.getByRole('button', { name: 'Settings', exact: true }).first(),
  settingsDialog: () => page.getByRole('dialog', { name: /Pane Settings/ }),
  remoteAccessNav: () => ui.settingsDialog().getByRole('button', { name: 'Remote Access', exact: true }),
  cloudSection: () => ui.settingsDialog().getByRole('heading', { name: /Cloud sandboxes/i }),
  credentialStatus: () => ui.settingsDialog().getByRole('definition'),
  credential: (label) => ui.settingsDialog().getByLabel(label, { exact: true }),
  saveCredentials: () => page.getByRole('button', { name: /Save credentials/i }),
  changeCredentials: () => page.getByRole('button', { name: /Change credentials/i }),
  startupScript: () => ui.settingsDialog().getByRole('textbox', { name: 'Startup script', exact: true }),
  saveStartupScript: () => ui.settingsDialog().getByRole('button', { name: 'Save Startup Script', exact: true }),
  nameInput: () => ui.settingsDialog().getByLabel('Name', { exact: true }),
  addSandbox: () => page.getByRole('button', { name: /Add cloud sandbox/i }),
  progress: (label) => page.getByRole('status', { name: `Progress for ${label}` }),
  row: (label) => page.getByRole('listitem', { name: `Cloud sandbox ${label}` }),
  rowAction: (verb, label) => page.getByRole('button', { name: `${verb} ${label}`, exact: true }),
  startupChip: (label) => ui.row(label).getByRole('alert').filter({ hasText: /Startup script failed/ }),
  viewLog: (label) => page.getByRole('button', { name: `View log for ${label}`, exact: true }),
  startupLog: (label) => page.getByRole('dialog', { name: `Startup log: ${label}` }),
  confirmRemove: (label) => page.getByRole('dialog', { name: `Remove ${label}?` }),
  // Expanded sidebar: the repository's "<repo> (Main)" row and each Pane's row (a git status badge can precede its name).
  openMainWorkspace: (repo) => page.getByRole('button', { name: `${repo} (Main)`, exact: true }),
  newPaneIn: (repo) => page.getByRole('button', { name: `New pane in ${repo}` }),
  openPane: (repo, pane) => page.getByRole('button', { name: new RegExp(`^\\S*${escapeRegExp(pane)}$`) }).first(),
  // The field's visible label isn't tied to it; its accessible name is the placeholder.
  projectName: (dialog) => dialog.getByRole('textbox', { name: 'Enter project name' }),
  addTool: () => page.getByRole('button', { name: 'Add tool' }).first(),
  tool: (name) => page.getByRole('menuitem', { name: new RegExp(`^${escapeRegExp(name)}`) }),
  panelTab: (name) => page.getByRole('tab', { name: new RegExp(`^${escapeRegExp(name)}`) }),
};
const visible = (locator, timeout = 1000) => locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

async function dismissFirstRun() {
  const targets = [
    () => page.getByRole('button', { name: 'Skip', exact: true }),
    () => page.getByRole('dialog', { name: 'Welcome to Pane' }).getByRole('button', { name: 'Close modal' }),
    () => page.getByRole('dialog', { name: 'Software Update' }).getByRole('button', { name: 'Close', exact: true }),
  ];
  for (let round = 0; round < 8; round++) {
    await sleep(600);
    let dismissed = false;
    for (const target of targets) {
      const button = target();
      if (await button.isVisible().catch(() => false) && await button.click({ timeout: 3000 }).then(() => true, () => false)) {
        dismissed = true;
        break;
      }
    }
    if (!dismissed) return;
  }
}
async function closeMenus() {
  await page.keyboard.press('Escape');
  await sleep(250);
}
async function closeSettings() {
  const settings = ui.settingsDialog();
  if (!(await visible(settings, 400))) return;
  await page.keyboard.press('Escape');
  if (await settings.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
  await settings.getByRole('button', { name: /^Close/ }).first().click({ timeout: 5000 }).catch(() => undefined);
  await settings.waitFor({ state: 'hidden', timeout: 5000 });
}
async function openSwitcher() {
  await closeSettings();
  // Already open (a step that failed with the menu up): clicking the chip again would close it.
  if (await visible(ui.manageConnections(), 300)) return;
  await ui.switcherChip().click();
  await sleep(400);
}
async function openCloud() {
  await closeMenus();
  if (!(await visible(ui.settingsDialog(), 300))) await ui.settingsButton().click();
  await ui.remoteAccessNav().click();
  await ui.cloudSection().waitFor({ timeout: 10_000 });
}
async function goHome() {
  await closeSettings();
  await ui.home().click();
  await ui.homeCard('GitHub').waitFor({ timeout: 10_000 });
}
async function rowText(label) {
  return ((await ui.row(label).innerText({ timeout: 2000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ');
}
const rowBadge = (text, badge) => new RegExp(`(^|\\s)${badge}(\\s|$)`).test(text);
async function isConnected(label) {
  if (!(await visible(ui.connectedChip(label), 500))) return false;
  await openSwitcher();
  const text = ((await ui.hostItem(label).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  await closeMenus();
  return /(?<!Dis)Connected\s*·/.test(text);
}
async function connectTo(label, timeoutMs = 90_000) {
  if (HANDS_OFF.has(label)) throw new Error(`refusing to select ${label}`);
  if (await isConnected(label)) return true;
  await openSwitcher();
  await ui.hostItem(label).click();
  return Boolean(await until(() => isConnected(label), timeoutMs, 2000));
}

// ---------------------------------------------------------------- the active host, read-only
function activeHost() {
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  if (!host) throw new Error(`no saved host "${state.label}"`);
  if (HANDS_OFF.has(host.label)) throw new Error(`refusing to read ${host.label}`);
  return { ...host, token: savedHostToken(paneDir, host.id) };
}
async function hostInvoke(channel, ...args) {
  const host = activeHost();
  return daemonInvoke(host.baseUrl, host.token, channel, ...args);
}
async function screenText(panelId, limit = 120) {
  const screen = await hostInvoke('runpane:panels:screen', { panelId, limit });
  return String(screen?.text ?? '').replace(/\u00a0/g, ' ');
}
const nonEmpty = (text) => text.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '');
const promptLine = /[$#>%]\s*$/;
const hostKind = cloud ? 'cloud sandbox' : 'remote host';
// The self-hosted host is this machine: on a Windows runner it is a Windows host (PowerShell, C:\ paths, and a
// typed Windows path is valid there), which the Linux-only checks account for.
const hostIsWindows = !cloud && windows;
const expected = {
  user: cloud ? 'user' : os.userInfo().username,
  hostname: cloud ? /^rp-[a-z0-9-]+$/ : new RegExp(`^${escapeRegExp(os.hostname())}$`, 'i'),
  home: cloud ? '/home/user' : fakeHome,
};
const hostPath = (...parts) => (hostIsWindows ? path.win32.join(...parts) : path.posix.join(...parts));
const samePath = (a, b) => (hostIsWindows ? String(a ?? '').replace(/\\/g, '/').toLowerCase() === String(b ?? '').replace(/\\/g, '/').toLowerCase() : a === b);

// Types into the terminal that is on screen, like a user, then waits until the command's output ends in a prompt.
async function typeInVisibleTerminal(text, { enter = true } = {}) {
  const terminal = page.locator('.xterm:visible').last();
  await terminal.waitFor({ timeout: 30_000 });
  await terminal.click();
  await page.keyboard.type(text, { delay: 15 });
  if (enter) await page.keyboard.press('Enter');
}
// The last screen row where `command` ends. A long prompt plus command wraps over several rows (DROP 1 D5: the
// worktree prompt pushed the command past the terminal width), so up to 4 consecutive rows are joined.
function commandEnd(lines, command) {
  for (let end = lines.length - 1; end >= 0; end--) {
    for (let start = end; start >= Math.max(0, end - 3); start--) {
      // It ends on `end`: the rows up to `end` hold it, the rows before `end` alone don't.
      if (lines.slice(start, end + 1).join('').includes(command) && !lines.slice(start, end).join('').includes(command)) return end;
    }
  }
  return -1;
}
async function runInTerminal(panelId, command, { timeoutMs = 60_000, done } = {}) {
  // The read finds the typed command on the screen; a clear would wipe it (rehearsal D7 false FAIL).
  if (/(^|[;&|]\s*)(clear|reset)\b/.test(command)) throw new Error(`kit bug: "${command}" clears the screen the check reads`);
  // Text left at the prompt (D3's unsubmitted sign-in line) is abandoned first with Ctrl+C, as a user would;
  // typing after it would run both.
  const pending = nonEmpty(await screenText(panelId).catch(() => '')).at(-1) ?? '';
  if (!promptLine.test(pending)) {
    log(`clearing the line left at the prompt: ${pending.slice(-60)}`);
    await page.locator('.xterm:visible').last().click();
    await page.keyboard.press('Control+C');
    await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 10_000, 300);
  }
  await typeInVisibleTerminal(command);
  let last = '';
  let stableSince = 0;
  const output = await until(async () => {
    const text = await screenText(panelId);
    const lines = nonEmpty(text);
    const at = commandEnd(lines, command);
    if (at < 0) return undefined;
    const after = lines.slice(at + 1);
    const finished = done ? done(after.join('\n')) : after.length > 0 && promptLine.test(after.at(-1));
    if (!finished) return undefined;
    if (text !== last) {
      last = text;
      stableSince = Date.now();
      return undefined;
    }
    return Date.now() - stableSince > 800 ? { lines: after, text } : undefined;
  }, timeoutMs, 400);
  if (!output) {
    const screen = await screenText(panelId).catch(() => '');
    fs.writeFileSync(path.join(out, `${String(shotIndex + 1).padStart(3, '0')}-${current?.id ?? 'setup'}-terminal-timeout.screen.txt`), redact(screen));
    throw new Error(`no output for "${command}" within ${Math.round(timeoutMs / 1000)} s`);
  }
  await sleep(700); // the window draws what the host already holds
  return output;
}

async function hostTerminalPanelId() {
  const info = await hostInvoke('host-terminal:get');
  return info?.panelId;
}
async function openHostTerminalFromSwitcher(label) {
  await openSwitcher();
  await ui.switcherTerminal(label).click();
  if (!(await visible(ui.hostTerminalTab(label), 30_000))) {
    await shot('host-terminal-not-shown', { oracle: { hostTerminal: await hostInvoke('host-terminal:get').catch((error) => String(error)) } });
    throw new Error(`"Open terminal on ${label}" did not show the "${label} · Terminal" tab`);
  }
  await page.locator('.xterm:visible').last().waitFor({ timeout: 30_000 });
  const panelId = await until(hostTerminalPanelId, 30_000);
  if (!panelId) throw new Error('host-terminal:get returned no panel');
  await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 30_000, 500);
  return panelId;
}

async function panelsOf(paneId) {
  return (await hostInvoke('panels:list', paneId)) ?? [];
}
async function addTool(paneId, toolName) {
  const before = new Set((await panelsOf(paneId)).map((panel) => panel.id));
  await ui.addTool().click();
  await ui.tool(toolName).first().click();
  const panel = await until(async () => (await panelsOf(paneId)).find((entry) => !before.has(entry.id)), 30_000);
  if (!panel) throw new Error(`no new ${toolName} panel in the Pane`);
  await page.locator('.xterm:visible').last().waitFor({ timeout: 60_000 });
  return panel.id;
}

// An agent panel is ready at its prompt; first-run screens are a FAIL, never answered for the user (ruling C).
async function waitAgentReady(panelId, agent, timeoutMs = 120_000) {
  const ready = agent === 'claude' ? /\? for shortcuts|bypass permissions on/i : /send|context left|\? for shortcuts|›/i;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = nonEmpty(await screenText(panelId, 60).catch(() => '')).slice(-30).join('\n');
    if (/Select login method|Paste code here|Sign in with ChatGPT/i.test(text)) throw new Error(`${agent} asks to sign in`);
    const screens = [
      [/Yes, I trust this folder|Do you trust the files|Quick safety check|allow Codex to work in this folder/i, 'folder-trust prompt'],
      [/Yes, I accept|Bypass Permissions mode/i, 'bypass-permissions accept screen'],
      [/Choose the text style|Press Enter to continue/i, 'onboarding screen'],
    ].filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
    if (screens.length > 0) {
      await shot(`${agent}-first-run-screen`);
      check(`${agent}-no-first-run-screens`, false, `${agent} showed: ${screens.join(', ')}`);
      throw new Error(`${agent} showed ${screens.join(', ')}; not answered for the user`);
    }
    if (ready.test(text)) {
      check(`${agent}-no-first-run-screens`, true, 'straight to the prompt');
      return;
    }
    await sleep(1500);
  }
  throw new Error(`${agent} was not ready within ${Math.round(timeoutMs / 1000)} s`);
}
async function askAgent(panelId, prompt, answered, timeoutMs = 300_000) {
  await typeInVisibleTerminal(prompt);
  const found = await until(async () => answered(await screenText(panelId, 200)), timeoutMs, 2000);
  await sleep(1500);
  return found;
}

// ---------------------------------------------------------------- pauses for Red (SOBECK)
async function waitForFlag(name, instructions, timeoutMs = Number(env.PAUSE_TIMEOUT_MS ?? 30 * 60_000)) {
  const flag = path.join(flagDir, name);
  const banner = ['', '='.repeat(78), `PAUSED for Red (${name}). ${instructions}`, `When done, create the flag file:`,
    windows ? `  New-Item -ItemType File -Force '${flag}'` : `  touch '${flag}'`, `(waiting up to ${Math.round(timeoutMs / 60_000)} min)`, '='.repeat(78), ''];
  for (const line of banner) log(line);
  const at = await until(async () => fs.existsSync(flag), timeoutMs, 2000);
  log(at ? `flag ${name} found; resuming` : `flag ${name} not created within the timeout`);
  return Boolean(at);
}

// ---------------------------------------------------------------- D0: startup script + Add cloud sandbox
async function d0() {
  await openCloud();
  if (relay) {
    const status = await ui.credentialStatus().allTextContents();
    check('wallet-is-test', status[1]?.trim() === 'test', `the saved boat wallet is "${status[1] ?? ''}"`);
    if (status[1]?.trim() !== 'test') throw new Error('the saved boat wallet is not "test": stop before creating anything');
  }
  const editor = ui.startupScript();
  await editor.waitFor({ timeout: 10_000 });
  // Whatever the user had there comes back at the end (D9); only its length and hash are recorded.
  original.startupScript = await editor.inputValue();
  results.startupScriptBefore = { length: original.startupScript.length, sha256: crypto.createHash('sha256').update(original.startupScript).digest('hex').slice(0, 16) };
  check('startup-warning-shown', await visible(ui.settingsDialog().getByText("Don't put secrets here; it's stored unencrypted."), 2000), 'the editor warns against secrets');
  await editor.fill(startupScript);
  await ui.saveStartupScript().click();
  check('startup-script-saved', await visible(ui.settingsDialog().getByText('Saved', { exact: true }), 10_000), 'the editor says Saved');
  await shot('startup-script-saved', { result: true });
  // D0_DRY=1: everything up to the Add click (0 starts), to prove the editor and the credentials before spending one.
  if (env.D0_DRY === '1') {
    await ui.nameInput().fill('rp-loop-cs-e2e-dry');
    check('add-button-ready', await ui.addSandbox().isEnabled(), 'Add cloud sandbox enabled (not clicked: D0_DRY)');
    await shot('dry-before-add');
    await ui.nameInput().fill('');
    return;
  }

  state.label = env.LABEL ?? (relay ? `e2e-${stamp}` : `rp-loop-cs-e2e-${stamp}`);
  saveState();
  await ui.nameInput().fill(state.label);
  countStart('create');
  await ui.addSandbox().click();
  const startedAt = Date.now();
  const progress = [];
  let sawStartup = false;
  let rowError;
  const running = await until(async () => {
    const steps = await ui.progress(state.label).getByRole('listitem').allTextContents().catch(() => []);
    for (const text of steps.map((line) => line.replace(/\s+/g, ' ').trim())) {
      if (text && !progress.some((line) => line.endsWith(` ${text}`))) progress.push(`${Math.round((Date.now() - startedAt) / 1000)} s ${text}`);
    }
    if (!sawStartup && steps.some((text) => /Running your startup script…/.test(text))) {
      sawStartup = true;
      await shot('add-running-startup-script', { result: true });
    }
    if (await visible(ui.row(state.label).getByRole('alert').filter({ hasNotText: /Startup script failed/ }), 100)) {
      rowError = (await ui.row(state.label).getByRole('alert').first().textContent()) ?? 'error';
      return true;
    }
    return rowBadge(await rowText(state.label), 'Running');
  }, Number(env.ADD_TIMEOUT_MS ?? 900_000), 1500);
  fs.writeFileSync(path.join(out, 'add-progress.txt'), `${redact(progress.join('\n'))}\n`);
  if (rowError) throw new Error(`Add cloud sandbox failed: ${rowError}`);
  check('add-listed-running', Boolean(running), `row ${state.label} Running after ${Math.round((Date.now() - startedAt) / 1000)} s; ${progress.length} progress lines`);
  check('add-showed-startup-script-step', sawStartup, sawStartup ? '"Running your startup script…" shown during Add' : `progress: ${JSON.stringify(progress)}`);
  await shot('sandbox-running', { result: true, oracle: { progress } });
  const host = savedHosts(paneDir).find((entry) => entry.label === state.label);
  check('saved-host-written', Boolean(host?.cloud?.sandboxId), JSON.stringify(host ?? null));
  if (host) {
    state.cloud = host.cloud;
    saveState();
    addSecret('sandboxHostToken', savedHostToken(paneDir, host.id));
    results.sandbox = { label: host.label, sandboxId: host.cloud?.sandboxId, hostname: host.cloud?.hostname };
  }
  if (mode === 'live' && host?.cloud) {
    const sandbox = await boatSandbox(host.cloud.sandboxId, boatOrg);
    check('boat-sandbox-named', sandbox.exists && /^rp-loop-cs-/.test(sandbox.name ?? ''), JSON.stringify(sandbox));
  }
}
const original = {};

// ---------------------------------------------------------------- D1: the host terminal from the switcher
async function d1() {
  check('connected', await connectTo(state.label), `switcher → ${state.label}`);
  await openSwitcher();
  check('switcher-offers-host-terminal', await visible(ui.switcherTerminal(state.label), 5000), `"Open terminal on ${state.label}" on the active row`);
  await shot('switcher-terminal-button');
  await closeMenus();
  const panelId = await openHostTerminalFromSwitcher(state.label);
  state.hostTerminalPanelId = panelId;
  saveState();
  check('host-terminal-tab', await visible(ui.hostTerminalTab(state.label), 2000), `tab "${state.label} · Terminal"`);
  check('host-terminal-heading', await visible(ui.hostTerminalHeading(state.label), 2000), `"Terminal on ${state.label}"`);
  const { lines } = await runInTerminal(panelId, 'whoami; hostname; pwd');
  if (hostIsWindows) {
    // PowerShell: whoami is DOMAIN\user and pwd prints a Path table.
    check('whoami', lines.some((line) => line.trim().toLowerCase().endsWith(`\\${expected.user.toLowerCase()}`)), lines.join(' | '));
    check('hostname', lines.some((line) => expected.hostname.test(line.trim())), lines.join(' | '));
    check('pwd-home', lines.some((line) => line.trim().toLowerCase() === expected.home.toLowerCase()), lines.join(' | '));
  } else {
    const [user, hostname, cwd] = lines;
    check('whoami', user?.trim() === expected.user, `${user} (want ${expected.user})`);
    check('hostname', expected.hostname.test(hostname?.trim() ?? ''), `${hostname} (want ${expected.hostname})`);
    check('pwd-home', cwd?.trim() === expected.home, `${cwd} (want ${expected.home})`);
  }
  await shot('host-terminal-whoami', { result: true, oracle: { panelId, lines } });
  // No repo is needed for it: the host's project list has nothing called host-terminal.
  const projects = (await hostInvoke('projects:get-all').catch(() => [])) ?? [];
  check('host-terminal-not-a-project', !projects.some((project) => /host-terminal/.test(`${project.name} ${project.path}`)), `${projects.length} projects`);
}

// ---------------------------------------------------------------- D3: clone while not signed in → prefilled terminal
async function openCloneDialog() {
  await goHome();
  await ui.homeCard('GitHub').click();
  const dialog = ui.dialog(/Clone from GitHub/);
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}
async function d3() {
  if (!(await connectTo(state.label))) throw new Error('not connected');
  const dialog = await openCloneDialog();
  check('clone-host-chip', await visible(ui.hostChip(dialog, state.label, hostKind), 3000), `"On: ${state.label} (${hostKind})"`);
  // The chip's icon: a cloud for a sandbox, a server for a self-hosted host (HostChip's data-host-icon).
  const icon = await ui.hostChip(dialog, state.label, hostKind).locator('xpath=..').getAttribute('data-host-icon').catch(() => null);
  check('host-chip-icon', icon === (cloud ? 'cloud' : 'server'), `icon ${icon}`);
  await dialog.getByLabel('Repository URL').fill(PRIVATE_REPO);
  const destination = await dialog.getByLabel('Destination').inputValue().catch(() => '');
  check('clone-destination-default-home', destination === '~', `destination "${destination}"`);
  await dialog.getByRole('button', { name: /^Clone/ }).last().click();
  const alert = ui.signInAlert(page, state.label);
  check('sign-in-error-shown', await visible(alert, 60_000), `"${state.label} isn't signed in to GitHub."`);
  check('sign-in-error-buttons', await visible(ui.signInOpenTerminal(state.label), 1000) && await visible(ui.tryAgain(), 1000), 'Open terminal … to sign in + Try again');
  await shot('clone-not-signed-in', { result: true });
  // Try again keeps the URL and destination and fails the same way.
  await ui.tryAgain().click();
  await sleep(1500);
  check('try-again-keeps-input', (await dialog.getByLabel('Repository URL').inputValue()) === PRIVATE_REPO, 'URL kept');
  check('try-again-fails-the-same', await visible(alert, 60_000), 'the notice is back');
  await shot('clone-try-again');
  await ui.signInOpenTerminal(state.label).click();
  await ui.hostTerminalTab(state.label).waitFor({ timeout: 30_000 });
  const panelId = await until(hostTerminalPanelId, 15_000);
  state.hostTerminalPanelId = panelId;
  saveState();
  // Typed, NOT submitted: the gh line is the last line on the screen, on the prompt, with nothing after it.
  const shown = await until(async () => {
    const lines = nonEmpty(await screenText(panelId));
    return lines.at(-1)?.trimEnd().endsWith(GH_PREFILL) ? lines : undefined;
  }, 20_000, 500);
  const lastLine = shown?.at(-1) ?? nonEmpty(await screenText(panelId)).at(-1) ?? '';
  check('prefill-typed-not-submitted', Boolean(shown) && lastLine.trimEnd().endsWith(GH_PREFILL) && !lastLine.trimEnd().startsWith('gh '),
    `last line: ${lastLine}`);
  await sleep(1000);
  await shot('terminal-prefilled', { result: true, oracle: { panelId, lastLines: (shown ?? []).slice(-4) } });
  // Nothing ran: still the same a few seconds later.
  await sleep(3000);
  check('prefill-still-unsubmitted', nonEmpty(await screenText(panelId)).at(-1) === lastLine, 'no output appeared');
}

// ---------------------------------------------------------------- D2: Red signs the host in (SOBECK)
async function d2() {
  const panelId = state.hostTerminalPanelId ?? await openHostTerminalFromSwitcher(state.label);
  if (!(await visible(ui.hostTerminalTab(state.label), 1000))) await openHostTerminalFromSwitcher(state.label);
  const ghLast = nonEmpty(await screenText(panelId)).at(-1) ?? '';
  check('gh-prefill-present', ghLast.trimEnd().endsWith(GH_PREFILL), `last line: ${ghLast}`);
  // The user presses Enter on the prefilled line (D3), then answers gh's prompts with their defaults.
  await page.locator('.xterm:visible').last().click();
  await page.keyboard.press('Enter');
  const codeShown = await until(async () => {
    const text = nonEmpty(await screenText(panelId)).slice(-8).join('\n');
    if (/one-time code/i.test(text)) return true;
    if (/\?\s.*(GitHub\.com|Authenticate Git|preferred protocol)/i.test(text.split('\n').at(-1) ?? '')) await page.keyboard.press('Enter');
    return undefined;
  }, 90_000, 1500);
  if (codeShown && /Press Enter to open/i.test(nonEmpty(await screenText(panelId)).slice(-3).join('\n'))) await page.keyboard.press('Enter');
  check('gh-device-code-shown', Boolean(codeShown), 'gh shows a one-time code');
  await shot('gh-device-code');
  const ghFlag = await waitForFlag('gh-signed-in', `In YOUR browser open https://github.com/login/device, enter the one-time code shown in the Pane window's "${state.label} · Terminal" tab, and approve. Wait until the terminal is back at its prompt.`);
  check('gh-flag', ghFlag, 'Red finished the GitHub sign-in');
  await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 120_000, 1000);
  await runInTerminal(panelId, 'codex login --device-auth', { timeoutMs: 60_000, done: (after) => /code|https:\/\//i.test(after) });
  await shot('codex-device-code');
  const codexFlag = await waitForFlag('codex-signed-in', `In YOUR browser open the URL shown in the "${state.label} · Terminal" tab (auth.openai.com/codex/device), enter the code shown there, and approve. Wait until the terminal is back at its prompt.`);
  check('codex-flag', codexFlag, 'Red finished the Codex sign-in');
  await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 120_000, 1000);
  const { lines } = await runInTerminal(panelId, 'gh auth status; codex login status', { timeoutMs: 60_000 });
  const text = lines.join('\n');
  check('gh-logged-in', /Logged in to github\.com/i.test(text), lines.filter((line) => /github\.com|account|Logged/i.test(line)).join(' | '));
  check('codex-logged-in', /Logged in using/i.test(text), lines.filter((line) => /Logged in|Not logged/i.test(line)).join(' | '));
  check('no-token-text', tokenShapes(text).length === 0, `token shapes: ${JSON.stringify(tokenShapes(text))}`);
  await shot('signed-in-status', { result: true, oracle: { panelId, lines } });
}

// ---------------------------------------------------------------- D4: clone / Windows path / open via the picker / new
async function projectsOnHost() {
  return ((await hostInvoke('projects:get-all')) ?? []).map((project) => ({ id: project.id, name: project.name, path: project.path }));
}
async function d4() {
  if (!(await connectTo(state.label))) throw new Error('not connected');
  // (a) Home > GitHub: URL, Browse on the host, destination ~, Clone.
  const dialog = await openCloneDialog();
  check('clone-host-chip', await visible(ui.hostChip(dialog, state.label, hostKind), 3000), `"On: ${state.label} (${hostKind})"`);
  await dialog.getByLabel('Repository URL').fill(cloneUrl);
  await dialog.getByRole('button', { name: /^Browse/ }).click();
  const picker = ui.picker(state.label);
  check('remote-picker-opens', await visible(picker, 10_000), `in-app folder browser on ${state.label}`);
  const pickerPath = async (want) => until(async () => {
    const shown = (await ui.pickerCurrent(picker).first().innerText().catch(() => '')) || await ui.pickerCurrent(picker).first().inputValue().catch(() => '');
    return shown.trim() === want ? shown.trim() : undefined;
  }, 10_000, 300);
  check('remote-picker-at-home', Boolean(await pickerPath(expected.home)), `Current folder ${expected.home}`);
  check('native-dialog-not-used-remote', (await app.evaluate(() => globalThis.__e2eNativeDialogs.length)) === 0, 'no native dialog for a remote host');
  await shot('clone-remote-picker', { result: true, oracle: await hostInvoke('fs:browse-directories', { path: '~' }).then((listing) => ({ path: listing?.path, home: listing?.home, entries: listing?.entries?.length })).catch((error) => ({ error: String(error) })) });
  await ui.pickerConfirm(picker).click();
  await picker.waitFor({ state: 'hidden', timeout: 5000 });
  const destination = await dialog.getByLabel('Destination').inputValue();
  check('clone-destination-home', destination === '~' || destination === expected.home, `destination "${destination}"`);
  await shot('clone-filled');
  await dialog.getByRole('button', { name: /^Clone/ }).last().click();
  const cloned = await until(async () => (await projectsOnHost()).find((project) => samePath(project.path, hostPath(expected.home, repoName))), 300_000, 2000);
  check('cloned-onto-host', Boolean(cloned), `project at ${expected.home}/${repoName}: ${JSON.stringify(cloned ?? null)}`);
  check('repo-open', await visible(ui.openMainWorkspace(repoName), 30_000), `${repoName} in the sidebar`);
  await shot('cloned-project', { result: true, oracle: { projects: await projectsOnHost() } });
  state.repoName = repoName;
  saveState();

  // (b) Open project with a typed Windows path is rejected, in the dialog (a Windows host accepts it).
  if (hostIsWindows) check('windows-path-rejected', null, 'the self-hosted host is Windows itself');
  else await windowsPathRejected();
  await d4OpenAndNew();
}

async function openRepositoryDialog() {
  await goHome();
  await ui.homeCard('Open Project').click();
  await ui.addRepositoryFooter().click();
  const add = ui.dialog(/^Open Repository/);
  await add.waitFor({ timeout: 10_000 });
  return add;
}
async function windowsPathRejected() {
  const add = await openRepositoryDialog();
  check('open-host-chip', await visible(ui.hostChip(add, state.label, hostKind), 3000), `"On: ${state.label} (${hostKind})"`);
  const before = await projectsOnHost();
  await ui.projectName(add).fill('montlakev2-windows-path');
  await add.getByLabel('Repository Path').fill(WINDOWS_PATH);
  await add.getByRole('button', { name: 'Open', exact: true }).click().catch(() => undefined);
  const sentence = `That's a path on this computer; ${state.label} is a Linux host. Pick a folder on ${state.label}.`;
  check('windows-path-rejected', await visible(add.getByText(sentence, { exact: false }), 15_000), sentence);
  const after = await projectsOnHost();
  check('windows-path-created-nothing', after.length === before.length, `projects ${before.length} → ${after.length}`);
  await shot('windows-path-rejected', { result: true, oracle: { projectsBefore: before.length, projectsAfter: after.length } });
  await add.getByRole('button', { name: 'Cancel', exact: true }).click();
}

async function d4OpenAndNew() {
  // (c) An existing repo on the host (put there from the host terminal) opened through the remote picker.
  const panelId = await openHostTerminalFromSwitcher(state.label);
  // `"$HOME/…"` and `;` mean the same in bash and PowerShell (a Windows self-hosted host).
  const { lines: cloneLines } = await runInTerminal(panelId, `git clone -q ${OPEN_REPO_URL} "$HOME/${openRepoDir}"; echo CLONE-EXIT-$?`, { timeoutMs: 180_000, done: (text) => /CLONE-EXIT-/.test(text) });
  check('open-repo-cloned-on-host', cloneLines.some((line) => /CLONE-EXIT-(0|True)\b/.test(line)), cloneLines.join(' | '));
  await shot('open-repo-on-host');
  const add = await openRepositoryDialog();
  await add.getByRole('button', { name: /^Browse/ }).click();
  const openPicker = ui.picker(state.label);
  await openPicker.waitFor({ timeout: 10_000 });
  check('open-picker-no-new-folder', (await ui.pickerNewFolder(openPicker).count()) === 0, 'no "New folder" in the Open browser (A8)');
  check('open-picker-marks-repo', await visible(ui.pickerEntry(openPicker, openRepoDir, true), 10_000), `"${openRepoDir}, git repo"`);
  await shot('open-picker-home');
  await ui.pickerEntry(openPicker, openRepoDir, true).click();
  const inRepo = await until(async () => ((await ui.pickerCurrent(openPicker).first().innerText().catch(() => '')) || '').trim() === hostPath(expected.home, openRepoDir), 10_000, 300);
  check('open-picker-entered-repo', Boolean(inRepo), `Current folder ${expected.home}/${openRepoDir}`);
  await shot('open-picker-repo');
  await ui.pickerConfirm(openPicker).click();
  await openPicker.waitFor({ state: 'hidden', timeout: 5000 });
  if (!(await ui.projectName(add).inputValue())) await ui.projectName(add).fill(openRepoDir);
  check('open-path-from-picker', (await add.getByLabel('Repository Path').inputValue()) === hostPath(expected.home, openRepoDir), await add.getByLabel('Repository Path').inputValue());
  await shot('open-filled');
  await add.getByRole('button', { name: 'Open', exact: true }).click();
  const opened = await until(async () => (await projectsOnHost()).find((project) => samePath(project.path, hostPath(expected.home, openRepoDir))), 60_000, 2000);
  check('open-existing-repo', Boolean(opened), JSON.stringify(opened ?? null));
  check('open-repo-in-sidebar', await visible(ui.openMainWorkspace(opened?.name ?? openRepoDir), 30_000), openRepoDir);
  await shot('open-existing-repo', { result: true, oracle: { projects: await projectsOnHost() } });

  // (d) New project creates the folder on the host (extra; not in the bar).
  await goHome();
  await ui.homeCard('New Project').click();
  const created = ui.dialog(/^New Project/);
  await created.waitFor({ timeout: 10_000 });
  const newName = `e2e-new-${stamp}`;
  await ui.projectName(created).fill(newName);
  await created.getByLabel('Repository Path').fill(`~/${newName}`);
  await created.getByRole('button', { name: 'Create', exact: true }).click();
  const made = await until(async () => (await projectsOnHost()).find((project) => samePath(project.path, hostPath(expected.home, newName))), 60_000, 2000);
  check('new-project-created', Boolean(made), JSON.stringify(made ?? null));
  await shot('new-project', { result: Boolean(made), oracle: { made } });
}

// ---------------------------------------------------------------- D5/D6: a new Pane, its Terminal / Claude / Codex
async function d5() {
  if (!(await connectTo(state.label))) throw new Error('not connected');
  const repo = state.repoName ?? repoName;
  await ui.openMainWorkspace(repo).click();
  await ui.newPaneIn(repo).first().click();
  const dialog = page.getByRole('dialog', { name: /^New Pane/ });
  const nameField = dialog.getByPlaceholder('Enter a name for your pane');
  await until(async () => (await nameField.inputValue()) !== '', 10_000, 300);
  const paneName = `e2e-${stamp}`;
  await until(async () => {
    if ((await nameField.inputValue()) !== paneName) await nameField.fill(paneName);
    await sleep(700);
    return (await nameField.inputValue()) === paneName;
  }, 15_000, 300);
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await visible(ui.openPane(repo, paneName), 90_000);
  await ui.openPane(repo, paneName).click();
  await sleep(1500);
  const session = await until(async () => ((await hostInvoke('sessions:get-all')) ?? []).find((entry) => entry.name === paneName), 30_000);
  if (!session) throw new Error(`Pane ${paneName} not on the host`);
  state.pane = { id: session.id, name: paneName, worktreePath: session.worktreePath };
  saveState();
  const panelId = await addTool(session.id, 'Terminal');
  state.pane.terminalPanelId = panelId;
  saveState();
  await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 30_000, 500);
  const { lines } = await runInTerminal(panelId, 'pwd; git rev-parse --show-toplevel; git branch --show-current; git worktree list');
  const [cwd, top, branch, ...worktrees] = lines.slice(0, -1).map((line) => line.trim());
  state.pane.branch = branch;
  saveState();
  check('pane-terminal-in-worktree', cwd === session.worktreePath && top === session.worktreePath, `pwd ${cwd}, toplevel ${top}, worktree ${session.worktreePath}`);
  check('pane-worktree-not-main', session.worktreePath !== hostPath(expected.home, repo), 'the Pane has its own worktree');
  // `git worktree list` rows can wrap: judged on the rows joined.
  const listed = new RegExp(`${escapeRegExp(session.worktreePath)}\\s+[0-9a-f]{7,}\\s+\\[${escapeRegExp(branch ?? '')}\\]`).test(worktrees.join(''));
  check('pane-branch', Boolean(branch) && listed, `branch ${branch}; worktree list ${JSON.stringify(worktrees)}`);
  await shot('pane-terminal-worktree', { result: true, oracle: { session: state.pane, lines } });
}

async function agentWhere(agent, toolName) {
  const panelId = await addTool(state.pane.id, toolName);
  state.pane[`${agent}PanelId`] = panelId;
  saveState();
  await waitAgentReady(panelId, agent);
  await shot(`${agent}-ready`);
  const prompt = 'Run the shell commands `pwd` and `git branch --show-current` here, then reply with exactly two lines: PWD=<pwd output> and BRANCH=<branch output>.';
  const answer = await askAgent(panelId, prompt, (text) => {
    const pwd = text.match(/^\s*[⏺●*•]?\s*PWD=(.+?)\s*$/m)?.[1];
    const branch = text.match(/^\s*BRANCH=(\S+)\s*$/m)?.[1];
    return pwd && branch ? { pwd, branch } : undefined;
  });
  check(`${agent}-answers`, Boolean(answer), JSON.stringify(answer ?? null));
  check(`${agent}-in-pane-worktree`, answer?.pwd === state.pane.worktreePath && answer?.branch === state.pane.branch,
    `${agent}: PWD=${answer?.pwd} BRANCH=${answer?.branch}; D5: ${state.pane.worktreePath} ${state.pane.branch}`);
  await shot(`${agent}-pwd-branch`, { result: true, oracle: { panelId, answer, d5: { worktreePath: state.pane.worktreePath, branch: state.pane.branch } } });
}
async function d6() {
  if (!state.pane) throw new Error('no Pane from D5');
  if (!(await connectTo(state.label))) throw new Error('not connected');
  await ui.openPane(state.repoName ?? repoName, state.pane.name).click();
  await agentWhere('claude', 'Claude Code');
  if (relay || env.CODEX === '1') await agentWhere('codex', 'Codex');
  else check('codex', null, 'Codex is signed in only by Red in D2 (SOBECK); not run here');
}

// ---------------------------------------------------------------- D7: startup script status, Stop/Start, failing script
async function startupStatus(panelId) {
  const { lines } = await runInTerminal(panelId, `cat ~/.local/state/runpane-cloud/startup-status.json; echo; grep -c ${MARKER} ${STARTUP_MARKER_LOG}`);
  const text = lines.join('\n');
  return { lines, exitCode: Number(text.match(/"exitCode"\s*:\s*(-?\d+)/)?.[1] ?? NaN), runs: Number(lines.filter((line) => /^\d+$/.test(line.trim())).at(-1) ?? NaN) };
}
async function d7() {
  if (!(await connectTo(state.label))) throw new Error('not connected');
  let panelId = await openHostTerminalFromSwitcher(state.label);
  const first = await startupStatus(panelId);
  check('startup-exit-0', first.exitCode === 0, `exitCode ${first.exitCode}`);
  check('startup-marker-once', first.runs >= 1, `${first.runs} marker line(s)`);
  await shot('startup-status-first', { result: true, oracle: first });
  await openCloud();
  check('row-no-chip-after-ok-run', !(await visible(ui.startupChip(state.label), 1000)), 'no ⚠ chip');
  check('row-open-terminal-while-running', await visible(ui.rowOpenTerminal(state.label), 2000), 'Open terminal in the Running row');
  await shot('row-running', { result: true });
  // The row's Open terminal opens the same host terminal (E2's second entry point).
  await ui.rowOpenTerminal(state.label).click();
  check('row-open-terminal-opens-it', await visible(ui.hostTerminalTab(state.label), 30_000), `tab "${state.label} · Terminal"`);
  check('row-open-terminal-same-terminal', (await hostTerminalPanelId()) === panelId, 'the same host terminal panel');
  await shot('row-open-terminal', { result: true });
  await openCloud();

  await ui.rowAction('Stop', state.label).click();
  let sawOpenTerminalWhileNotRunning = false;
  const stopped = await until(async () => {
    const row = await rowText(state.label);
    if (!rowBadge(row, 'Running') && await visible(ui.rowOpenTerminal(state.label), 200)) sawOpenTerminalWhileNotRunning = true;
    return rowBadge(row, 'Stopped');
  }, Number(env.STOP_WAIT_MS ?? 1_000_000), 1500);
  check('row-stopped', Boolean(stopped), await rowText(state.label));
  check('stopped-hides-open-terminal', !sawOpenTerminalWhileNotRunning && !(await visible(ui.rowOpenTerminal(state.label), 1000)), 'no Open terminal while stopping/stopped');
  await shot('row-stopped', { result: true });

  countStart('start');
  await ui.rowAction('Start', state.label).click();
  const running = await until(async () => rowBadge(await rowText(state.label), 'Running'), 900_000, 2000);
  check('row-running-again', Boolean(running), await rowText(state.label));
  await shot('row-running-again');
  await closeSettings();
  check('reconnected', await connectTo(state.label, 180_000), state.label);
  panelId = await openHostTerminalFromSwitcher(state.label);
  check('same-host-terminal', panelId === state.hostTerminalPanelId, `panel ${panelId} (before ${state.hostTerminalPanelId})`);
  const second = await until(async () => {
    const status = await startupStatus(panelId);
    return status.runs >= first.runs + 1 && status.exitCode === 0 ? status : undefined;
  }, 600_000, 15_000) ?? await startupStatus(panelId);
  check('startup-ran-again-on-start', second.runs >= first.runs + 1 && second.exitCode === 0, `marker lines ${first.runs} → ${second.runs}, exitCode ${second.exitCode}`);
  await shot('startup-status-after-start', { result: true, oracle: second });
  // D1's hostname once more, after a reboot (the first-boot identity unit may only apply it then).
  const { lines: afterBoot } = await runInTerminal(panelId, 'hostname');
  check('hostname-after-start', expected.hostname.test(afterBoot[0]?.trim() ?? ''), `${afterBoot[0]} (want ${expected.hostname})`);
  await shot('hostname-after-start', { oracle: { lines: afterBoot } });

  // A failing script, set through the editor, surfaces in the row.
  await openCloud();
  await ui.startupScript().fill(`${startupScript}exit 1\n`);
  await ui.saveStartupScript().click();
  const chip = await until(async () => (await visible(ui.startupChip(state.label), 500)) && await ui.startupChip(state.label).innerText(), 660_000, 3000);
  check('failing-script-chip', /Startup script failed \(exit 1\)/.test(chip ?? ''), `chip: ${chip ?? 'none'}`);
  await shot('startup-chip', { result: true, oracle: { chip } });
  await ui.viewLog(state.label).click();
  const logDialog = ui.startupLog(state.label);
  check('view-log-dialog', await visible(logDialog, 10_000), `"Startup log: ${state.label}"`);
  const logText = (await logDialog.innerText().catch(() => '')) ?? '';
  check('view-log-shows-run', logText.includes(MARKER), `${logText.split('\n').length} lines, marker ${logText.includes(MARKER)}`);
  await shot('startup-log', { result: true });
  await page.keyboard.press('Escape');
}

// ---------------------------------------------------------------- D8: Claude edits, commits, pushes and opens a draft PR
// Finds the link the way a mouse does: hovers the visible terminal row by row until xterm shows the link pointer.
async function clickTerminalLink(urlPattern) {
  const screen = page.locator('.xterm:visible .xterm-screen').last();
  const box = await screen.boundingBox();
  if (!box) return undefined;
  const opened = () => app.evaluate(() => globalThis.__e2eOpened.slice());
  const before = (await opened()).length;
  for (let y = box.y + box.height - 6; y > box.y; y -= 8) {
    for (let x = box.x + 12; x < box.x + Math.min(box.width, 900); x += 24) {
      await page.mouse.move(x, y);
      const pointer = await page.locator('.xterm:visible').last().evaluate((element) => element.classList.contains('xterm-cursor-pointer') || getComputedStyle(element.querySelector('.xterm-screen') ?? element).cursor === 'pointer').catch(() => false);
      if (!pointer) continue;
      await page.mouse.click(x, y);
      await sleep(800);
      let urls = (await opened()).slice(before);
      if (urls.length === 0) {
        await page.keyboard.down(windows ? 'Control' : 'Control');
        await page.mouse.click(x, y);
        await page.keyboard.up('Control');
        await sleep(800);
        urls = (await opened()).slice(before);
      }
      const hit = urls.find((url) => urlPattern.test(url));
      if (hit) return hit;
    }
  }
  return undefined;
}
// Windows: the window the click brought forward (the browser), and only that window.
function captureForegroundWindow(file) {
  const script = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class E2EWin { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
public struct RECT { public int L, T, R, B; } }
"@
Add-Type -AssemblyName System.Drawing
$h = [E2EWin]::GetForegroundWindow(); $r = New-Object E2EWin+RECT; [void][E2EWin]::GetWindowRect($h, [ref]$r)
$t = New-Object System.Text.StringBuilder 512; [void][E2EWin]::GetWindowText($h, $t, 512)
$b = New-Object System.Drawing.Bitmap ([Math]::Max(1, $r.R - $r.L)), ([Math]::Max(1, $r.B - $r.T))
$g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}'); Write-Output $t.ToString()`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, title: (run.stdout ?? '').trim() };
}
async function d8() {
  if (!state.pane?.claudePanelId) throw new Error('no Claude panel from D6');
  if (!(await connectTo(state.label))) throw new Error('not connected');
  await ui.openPane(state.repoName ?? repoName, state.pane.name).click();
  await ui.panelTab('Claude Code').click();
  const panelId = state.pane.claudePanelId;
  const line = `Real-user e2e ${stamp}`;
  const prompt = `In this repository: append the line "${line}" to README.md (create it if missing), commit it with the message "e2e: ${stamp}", `
    + `push it to the remote branch ${prBranch} (git push -u origin HEAD:${prBranch}), then run gh pr create --draft --repo ${prRepo} --head ${prBranch} `
    + `--title "e2e ${stamp}" --body "Real-user e2e (Run 8)". Finish with one line: PR=<the pull request URL>.`;
  const prPattern = new RegExp(`https://github\\.com/${escapeRegExp(prRepo)}/pull/\\d+`);
  const answer = await askAgent(panelId, prompt, (text) => text.match(new RegExp(`PR=(${prPattern.source})`))?.[1], 600_000);
  results.prUrl = answer ?? null;
  writeResults();
  check('pr-url-shown', Boolean(answer), answer ?? 'no PR= line');
  await shot('claude-pr-transcript', { result: Boolean(answer), oracle: { prUrl: answer } });
  if (!answer) return;
  // Opened like a user: a click on the link in the transcript.
  const clicked = await clickTerminalLink(prPattern);
  check('pr-link-opened', clicked === answer, `the click opened ${clicked ?? 'nothing'}`);
  if (windows && clicked) {
    await sleep(6000);
    const file = path.join(out, `${String(++shotIndex).padStart(3, '0')}-D8-pr-page-browser.png`);
    const capture = captureForegroundWindow(file);
    check('pr-page-captured', capture.status === 0 && fs.existsSync(file), `foreground window "${capture.title}"`);
    current.shots.push({ file: path.basename(file), videoAt: videoAt(), result: capture.status === 0, window: capture.title });
  }
  // And confirmed from the Pane's own terminal, typed like a user.
  await ui.panelTab('Terminal').click();
  const { lines } = await runInTerminal(state.pane.terminalPanelId, `gh pr view ${answer} --json url,isDraft,headRefName,state`, { timeoutMs: 60_000 });
  const view = lines.join('');
  check('pr-is-draft-on-branch', /"isDraft":\s*true/.test(view) && view.includes(`"headRefName":"${prBranch}"`) && /"state":"OPEN"/.test(view), view);
  await shot('pr-view', { result: true, oracle: { lines } });
}

// ---------------------------------------------------------------- D9: Remove through the UI, then regression checks
async function d9() {
  if (mode === 'fake') {
    await openSwitcher();
    await ui.manageConnections().click();
    await page.getByRole('button', { name: `Delete ${state.label}` }).click();
    await sleep(1500);
    check('host-deleted', !savedHosts(paneDir).some((host) => host.label === state.label), state.label);
    await shot('host-deleted', { result: true });
    fakeDaemonKill();
    return;
  }
  await openCloud();
  await ui.rowAction('Remove', state.label).click();
  const confirm = ui.confirmRemove(state.label);
  check('remove-asks-first', await visible(confirm, 5000), `"Remove ${state.label}?"`);
  await shot('remove-confirm');
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  const gone = await until(async () => !(await visible(ui.row(state.label), 500)), 300_000, 2000);
  check('row-gone', Boolean(gone), state.label);
  check('saved-host-gone', !savedHosts(paneDir).some((host) => host.label === state.label), 'no saved host');
  await shot('removed', { result: true });
  if (mode === 'live' && state.cloud) {
    const sandbox = await until(async () => {
      const answer = await boatSandbox(state.cloud.sandboxId, boatOrg);
      return answer.exists ? undefined : answer;
    }, 180_000, 5000);
    check('boat-sandbox-gone', Boolean(sandbox), JSON.stringify(sandbox ?? null));
    const devices = await until(async () => {
      const found = await tailnetDevices(state.cloud.hostname);
      return found.length === 0 ? found : undefined;
    }, 180_000, 5000);
    check('tailnet-device-gone', Boolean(devices), state.cloud.hostname);
  }
}

async function restoreStartupScript() {
  if (!cloud || original.startupScript === undefined) return;
  await openCloud();
  await ui.startupScript().fill(original.startupScript);
  await ui.saveStartupScript().click();
  const ok = await visible(ui.settingsDialog().getByText('Saved', { exact: true }), 10_000);
  results.regression.push({ name: 'startup-script-restored', verdict: ok ? 'PASS' : 'FAIL', detail: `length ${original.startupScript.length}` });
  await shot('startup-script-restored');
  await closeSettings();
}

// The local host is unchanged: Browse on This computer asks for the native dialog, with no in-app browser.
async function regressionLocalBrowse() {
  // With no remote host left (D9 removed the last one) there is no switcher: the window is already on This computer.
  await closeSettings();
  if (await visible(ui.switcherChip(), 2000)) {
    await openSwitcher();
    await ui.localItem().click();
    await sleep(2000);
  }
  await goHome();
  await ui.homeCard('New Project').click();
  const dialog = ui.dialog(/^New Project/);
  await dialog.waitFor({ timeout: 10_000 });
  const chip = await visible(ui.hostChip(dialog, null), 3000);
  const asked = await app.evaluate(() => globalThis.__e2eNativeDialogs.length);
  await dialog.getByRole('button', { name: /^Browse/ }).click();
  await sleep(1500);
  const native = (await app.evaluate(() => globalThis.__e2eNativeDialogs.length)) > asked;
  const inApp = await visible(page.getByRole('dialog', { name: /^Choose a folder on/ }), 1000);
  const ok = native && !inApp && chip;
  results.regression.push({ name: 'local-browse-native', verdict: ok ? 'PASS' : 'FAIL', detail: `native dialog asked ${native}, in-app browser ${inApp}, chip "On: This computer" ${chip}` });
  log(ok ? 'PASS' : 'FAIL', 'regression local-browse-native', `native ${native} inApp ${inApp} chip ${chip}`);
  await shot('regression-local-browse');
  await closeMenus();
}

// Hosts saved before the run (testina on SOBECK) come out unchanged, and none was ever selected.
const hostFingerprint = () => savedHosts(paneDir).filter((host) => host.label !== state.label)
  .map((host) => ({ label: host.label, baseUrl: host.baseUrl, cloud: host.cloud ?? null, tokenSha256: crypto.createHash('sha256').update(savedHostToken(paneDir, host.id) ?? '').digest('hex').slice(0, 16) }))
  .sort((a, b) => a.label.localeCompare(b.label));

// ---------------------------------------------------------------- live: credentials, in a session with no video
async function liveCredentials() {
  await launch({ video: false });
  await openCloud();
  if (!(await visible(ui.changeCredentials(), 1000))) {
    for (const [label, name] of [['boat API key', 'boatApiKey'], ['Tailscale OAuth client ID', 'tailscaleClientId'], ['Tailscale OAuth client secret', 'tailscaleClientSecret'], ['Claude token', 'claudeToken']]) {
      await ui.credential(label).fill(secretValue(name));
    }
    await ui.credential('boat wallet').fill(boatOrg);
    await ui.saveCredentials().click();
    await until(async () => !(await ui.saveCredentials().isVisible().catch(() => false)) || !(await ui.saveCredentials().isDisabled()), 60_000, 1000);
  }
  const status = await ui.credentialStatus().allTextContents();
  log(`credentials: ${status.map((text) => text.trim()).join(' / ')}`);
  if (status[1]?.trim() !== 'test') throw new Error('credentials not saved for the test wallet');
  await closeApp();
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(flagDir, { recursive: true });
  for (const name of ['gh-signed-in', 'codex-signed-in']) fs.rmSync(path.join(flagDir, name), { force: true });
  log(`mode ${mode}, steps ${[...wanted].join(',')}, flags in ${flagDir}`);
  if (mode === 'live') await liveCredentials();
  if (mode === 'fake') {
    const payload = fakeSetup();
    fakeDaemonStart();
    if (!(await until(() => health(fakeBaseUrl), 90_000))) throw new Error('self-hosted host did not come up');
    fakeSaveHost(payload);
    state.label = payload.label;
    saveState();
  }
  const hostsBefore = hostFingerprint();
  await launch();
  await shot('launched');
  try {
    await step('D0', 'Startup script through Settings, then Add cloud sandbox', d0, { applies: cloud, why: 'cloud sandboxes only' });
    if (env.D0_DRY === '1') return;
    if (!state.label) throw new Error('no host to run on');
    await step('D1', 'Host terminal from the switcher: whoami; hostname; pwd', d1);
    await step('D3', 'Clone while not signed in → sign-in error → prefilled terminal', d3);
    await step('D2', 'Red signs the host in to GitHub and Codex (device codes)', d2, { applies: relay, why: 'needs Red (SOBECK only)' });
    await step('D4', 'Clone via Home > GitHub; Windows path rejected; Open via the remote picker', d4);
    await step('D5', 'New Pane: its terminal is in the Pane\'s worktree', d5);
    await step('D6', 'Claude Code (and Codex) print pwd and branch = D5', d6);
    await step('D7', 'Startup status, Stop/Start re-runs it, a failing script shows the chip', d7, { applies: cloud, why: 'cloud sandboxes only' });
    await step('D8', 'Claude edits, commits, pushes and opens a draft PR', d8, { applies: relay || env.D8 === '1', why: 'needs Red\'s GitHub sign-in (SOBECK only)' });
  } finally {
    if (state.label) await step('D9', 'Remove through the UI', d9);
    current = undefined;
    await restoreStartupScript().catch((error) => log('restore startup script failed:', error.message));
    await regressionLocalBrowse().catch((error) => results.regression.push({ name: 'local-browse-native', verdict: 'FAIL', detail: String(error.message) }));
    const hostsAfter = hostFingerprint();
    const same = JSON.stringify(hostsBefore) === JSON.stringify(hostsAfter);
    results.regression.push({ name: 'other-hosts-unchanged', verdict: same ? 'PASS' : 'FAIL', detail: `${hostsBefore.map((host) => host.label).join(', ') || 'none'}` });
    await closeApp();
    fakeDaemonKill();
    // The short fake home outside the work dir goes too (its pairing token in .pane included).
    if (mode === 'fake' && !env.FAKE_HOME && fakeHome.startsWith(os.tmpdir())) fs.rmSync(fakeHome, { recursive: true, force: true });
    const known = scanForSecrets([out]);
    const shapes = scanForTokenShapes([out]);
    results.secretScan = { files: known.files, knownValueHits: known.hits.map((hit) => ({ file: path.relative(out, hit.file), names: hit.names })), tokenShapeHits: shapes.map((hit) => ({ file: path.relative(out, hit.file), shapes: hit.shapes })) };
    log(`secret scan: ${known.files} files, ${known.hits.length} known-value hits, ${shapes.length} token-shape hits`);
    results.verdicts = Object.fromEntries(results.steps.map((entry) => [entry.id, entry.verdict]));
    writeResults();
    log(`verdicts ${JSON.stringify(results.verdicts)}; regression ${JSON.stringify(results.regression.map((entry) => `${entry.name}:${entry.verdict}`))}; PR ${results.prUrl ?? '-'}`);
  }
}

main().then(() => process.exit(results.steps.some((entry) => entry.verdict === 'FAIL') ? 1 : 0), (error) => {
  log('FATAL', error instanceof Error ? error.stack ?? error.message : String(error));
  writeResults();
  process.exit(2);
});
