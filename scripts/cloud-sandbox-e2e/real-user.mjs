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
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSecret, loadSecret, redact, scanForSecrets, scanForTokenShapes, secretNames, secretValue, tokenShapes } from './secrets.mjs';
import { boatExec, boatSandbox, daemonInvoke, health, savedHostToken, savedHosts, tailnetDevices } from './oracles.mjs';

const env = process.env;
// Video needs Playwright's ffmpeg: the Windows kit ships it in kit/ms-playwright (cs-desktop.yml). Playwright reads this
// when it loads, so it is imported after.
const kitBrowsers = fileURLToPath(new URL('./ms-playwright', import.meta.url));
if (!env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(kitBrowsers)) env.PLAYWRIGHT_BROWSERS_PATH = kitBrowsers;
const { _electron: electron } = await import('playwright-core');
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
// MMDDtHHMM: not shaped like a device code (XXXX-XXXX), which every scan treats as a secret.
const stamp = `${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}t${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
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
// REAL-2 (Red 12:07 PT): BROWSER=false so gh never opens a browser on the host. GH_PREFILL overrides it for older drops.
const D3_FOLDER = 'e2e-d3';
// Obviously fake, and not shaped like any real GitHub token (W4: still in the exact-value scan).
const DUMMY_GITHUB_TOKEN = 'e2e-dummy-not-a-real-token-0000';
const GH_PREFILL = env.GH_PREFILL ?? 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
const MARKER = 'E2E_MARKER';
const STARTUP_MARKER_LOG = '~/e2e-startup-marker.log';
const startupScript = `# cs-e2e marker (Run 8): one line per run\necho "${MARKER} $(date -Is)" >> ${STARTUP_MARKER_LOG}\necho ${MARKER}\n`;

const allSteps = ['D0', 'D1', 'D3', 'D2', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'];
const wanted = new Set(env.STEPS ? env.STEPS.split(',') : allSteps);
// NO_REMOVE=1: the sandbox stays for a report first; Remove is a later STEPS=D9 run (orchestrator, rehearsal 2).
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
// The credentials saved in the app (Red's on SOBECK, his GitHub token included once he pastes it), registered so every
// log and evidence file is searched for them; values stay in memory, reported by name, length and sha256[:12] only.
function registerSavedCredentials() {
  const credentialsFile = path.join(env.RUNPANE_CLOUD_DIR ?? path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'runpane-cloud'), 'credentials.json');
  const found = [];
  const register = (value, keyPath) => {
    if (typeof value === 'string' && value.length >= 16) {
      addSecret(`cloudCredential:${keyPath}`, value);
      found.push(`${keyPath} (len ${value.length}, sha256 ${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)})`);
    } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) register(child, `${keyPath}.${key}`);
  };
  try {
    register(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')), 'credentials');
  } catch {
    // None saved yet: D0 reports it.
  }
  return found;
}
if (relay) {
  registerSavedCredentials();
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
    args: ['--no-sandbox'],
    env: appEnv,
    timeout: 120_000,
    // One recording of the whole run; no Playwright trace (it would record the launch environment).
    ...(video && env.VIDEO !== '0' ? { recordVideo: { dir: path.join(out, 'video'), size: { width: 1440, height: 900 } } } : {}),
  });
  const mainLog = path.join(out, 'app-main.log');
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk) => fs.appendFileSync(mainLog, redact(chunk.toString())));
  await app.firstWindow();
  // The app's own window (index.html), whichever opens first; every window's URL is logged for diagnosis.
  page = await until(async () => {
    const pages = app.windows();
    log(`windows: ${pages.map((entry) => entry.url().replace(/^.*[\\/]/, '')).join(', ') || 'none'}`);
    return pages.find((entry) => /index\.html/.test(entry.url()));
  }, 120_000, 2000) ?? app.windows()[0];
  if (video) videoStartedAt = Date.now();
  if (video) startCodeWatch();
  page.on('console', (message) => fs.appendFileSync(path.join(out, 'app-console.log'), `${redact(`[${message.type()}] ${message.text()}`)}\n`));
  // The UI is up when the sidebar's Home button renders; a load event can be missed or late.
  if (!(await visible(page.getByRole('button', { name: 'Home', exact: true }), 120_000))) {
    await page.screenshot({ path: path.join(out, 'launch-no-ui.png') }).catch(() => undefined);
    throw new Error('the app window shows no UI within 120 s');
  }
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
  stopCodeWatch();
  const video = page?.video();
  await app?.close().catch(() => undefined);
  app = undefined;
  if (!video) return;
  const file = await video.path().catch(() => '');
  if (!file || !fs.existsSync(file)) return;
  if (codeOnScreenSince !== null) codeIntervals.push([codeOnScreenSince, null]);
  if (codeIntervals.length === 0) {
    results.video.push(path.relative(out, file));
    return;
  }
  cutCodeFromVideo(file);
}

// Cuts every interval that showed a device code (2 s margins) out of the recording with Playwright's own ffmpeg, keeping
// the rest as numbered parts; results.video gives each part's offset in the run. If cutting fails the recording is
// deleted: it is never kept with a code in it.
function cutCodeFromVideo(file) {
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH ?? (windows ? path.join(env.LOCALAPPDATA ?? '', 'ms-playwright') : path.join(realHome, '.cache', 'ms-playwright'));
  const ffmpeg = path.join(browsers, 'ffmpeg-1011', windows ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');
  const cuts = codeIntervals.map(([from, to]) => [Math.max(0, from - 2), to === null ? null : to + 2]).sort((a, b) => a[0] - b[0]);
  const keep = [];
  let at = 0;
  for (const [from, to] of cuts) {
    if (from > at) keep.push([at, from]);
    if (to === null) {
      at = null;
      break;
    }
    at = Math.max(at, to);
  }
  if (at !== null) keep.push([at, null]);
  let ok = fs.existsSync(ffmpeg);
  const parts = [];
  for (const [index, [from, to]] of keep.entries()) {
    if (!ok) break;
    const part = file.replace(/\.webm$/, `-part${index + 1}.webm`);
    const run = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-ss', String(from), ...(to === null ? [] : ['-to', String(to)]), '-c:v', 'libvpx', '-b:v', '1M', '-an', part], { encoding: 'utf8', timeout: 600_000 });
    ok = run.status === 0 && fs.existsSync(part);
    if (ok) parts.push({ file: path.relative(out, part), from, to });
  }
  fs.rmSync(file, { force: true });
  results.videoCuts = cuts.map(([from, to]) => ({ from, to }));
  if (ok) {
    results.video.push(...parts);
    log(`video: cut ${cuts.length} device-code interval(s); ${parts.length} part(s) kept`);
  } else {
    for (const part of parts) fs.rmSync(path.join(out, part.file), { force: true });
    check('video-code-cut', false, `could not cut the device code out (${fs.existsSync(ffmpeg) ? 'ffmpeg failed' : `no ${ffmpeg}`}); the recording was deleted`);
  }
}
const videoAt = () => (videoStartedAt ? Math.round((Date.now() - videoStartedAt) / 100) / 10 : null);

// A screenshot of the window, its accessibility snapshot and (when given) the oracle read that decided the check,
// all secret-scanned before they are written. `result: true` marks the shot that shows the step's result.
async function shot(what, { oracle, result = false } = {}) {
  const entry0 = {};
  const base = path.join(out, `${String(++shotIndex).padStart(3, '0')}-${current?.id ?? 'setup'}-${what}`);
  // While a device code is on screen the terminal is masked in the shot (Red's rule: never show it in evidence).
  // On EVERY shot, whatever the kit believes: the code element by its frozen names and any text shaped like a device
  // code (backstop); while a code is known to be on screen also the kit's own mask (the terminal, or the code element).
  const mask = [ui.deviceCode(), page.getByText(DEVICE_CODE_SHAPE), ...(codeOnScreenSince === null ? [] : await codeMask())];
  await page.screenshot({ path: `${base}.png`, mask }).catch(() => undefined);
  if (codeOnScreenSince !== null || (await ui.deviceCode().count().catch(() => 0)) > 0) entry0.masked = 'the device code (on screen at this shot)';
  const aria = redact(await page.locator('body').ariaSnapshot().catch(() => ''));
  fs.writeFileSync(`${base}.aria.yml`, aria);
  const entry = { ...entry0, file: path.basename(`${base}.png`), videoAt: videoAt(), result };
  if (oracle !== undefined) {
    const text = redact(JSON.stringify(oracle, null, 2));
    fs.writeFileSync(`${base}.oracle.json`, `${text}\n`);
    entry.oracle = path.basename(`${base}.oracle.json`);
  }
  // What is written is scanned (redacted text): a shape left after redaction would be a leak.
  const shapes = [...new Set([...tokenShapes(aria), ...(oracle === undefined ? [] : tokenShapes(redact(JSON.stringify(oracle))))])];
  if (shapes.length > 0) check(`no-token-on-screen:${what}`, false, `token shapes in the window or its oracle: ${shapes.join(', ')}`);
  current?.shots.push(entry);
  log('SHOT', entry.file, `video ${entry.videoAt ?? '-'} s`);
}

// Proves a mask in the SAVED image: the shot is loaded into the page and the pixels under `locator` must all be
// Playwright's mask colour (#FF00FF). No image library needed.
async function maskedInShot(file, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  const dataUrl = `data:image/png;base64,${fs.readFileSync(path.join(out, file)).toString('base64')}`;
  return page.evaluate(async ({ dataUrl, box }) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    // Screenshots are in device pixels; the box is in CSS pixels.
    const scale = image.width / window.innerWidth;
    const pixels = context.getImageData(Math.floor(box.x * scale) + 1, Math.floor(box.y * scale) + 1, Math.max(1, Math.floor(box.width * scale) - 2), Math.max(1, Math.floor(box.height * scale) - 2)).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 240 || pixels[index + 1] > 15 || pixels[index + 2] < 240) return false;
    }
    return true;
  }, { dataUrl, box }).catch(() => false);
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
  // Whatever the step left open (a dialog, a menu, Settings) is closed, so the next step starts from the window.
  await closeSettings().catch(() => undefined);
  for (let round = 0; round < 2; round++) await closeMenus().catch(() => undefined);
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
  // E3 v2 in-app sign-in: the product's FROZEN names (cs-clone-auth, iface-real.md "E3 v2 UI: FROZEN names").
  signInGitHub: () => page.getByRole('button', { name: 'Sign in to GitHub', exact: true }),
  deviceCode: () => page.getByLabel('One-time code', { exact: true }).or(page.locator('[data-secret="github-device-code"]')),
  deviceCodePanel: () => ui.deviceCode().first().locator('xpath=ancestor::div[2]'),
  copyCode: () => ui.deviceCodePanel().getByRole('button', { name: /^(Copy|Copied)$/ }),
  openDeviceLink: () => ui.deviceCodePanel().getByRole('button', { name: 'Open github.com/login/device', exact: true }),
  signedInAs: () => page.getByText(/^Signed in to GitHub as /),
  settingsButton: () => page.getByRole('button', { name: 'Settings', exact: true }).first(),
  settingsDialog: () => page.getByRole('dialog', { name: /Pane Settings/ }),
  remoteAccessNav: () => ui.settingsDialog().getByRole('button', { name: 'Remote Access', exact: true }),
  cloudSection: () => ui.settingsDialog().getByRole('heading', { name: /Cloud sandboxes/i }),
  credentialStatus: () => ui.settingsDialog().getByRole('definition'),
  credential: (label) => ui.settingsDialog().getByLabel(label, { exact: true }),
  saveCredentials: () => page.getByRole('button', { name: /Save credentials/i }),
  // E6: the GitHub token in the credentials form, its Set/Not set status, the clone error's route there, the row result.
  // Its own section in Settings > Remote Access: status term "Saved token", textbox "GitHub token", button "Save GitHub Token".
  githubTokenField: () => ui.settingsDialog().getByRole('textbox', { name: 'GitHub token', exact: true }),
  saveGithubToken: () => ui.settingsDialog().getByRole('button', { name: 'Save GitHub Token', exact: true }),
  githubTokenStatus: () => ui.settingsDialog().getByRole('term').filter({ hasText: /^Saved token$/ }).first().locator('xpath=following-sibling::*[1]'),
  addTokenNotice: () => page.getByRole('alert').filter({ hasText: 'Add a GitHub token in Settings' }),
  openSettingsForToken: () => page.getByRole('button', { name: 'Open Settings', exact: true }),
  rowGithubSignedIn: (label) => ui.row(label).getByText(/GitHub: signed in as \S+/),
  rowGithubInvalid: (label) => ui.row(label).getByText(/GitHub token invalid/),
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
// A7: the shot must SHOW the result, not just hold it in the aria tree (rehearsal D0: the progress line was below the
// fold of the Settings dialog). Scrolls it into view and checks it is inside the window before the shot.
async function inView(name, locator) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await sleep(300);
  const shown = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
  }).catch(() => false);
  check(`in-view:${name}`, shown, shown ? 'scrolled into the window' : 'not inside the window for the shot');
  return shown;
}
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
async function typeInVisibleTerminal(text, { enter = true, panelId } = {}) {
  const terminal = page.locator('.xterm:visible').last();
  await terminal.waitFor({ timeout: 30_000 });
  await terminal.click();
  // A keystroke right after the focus can be lost (windows-latest: "hoami"); type, check the line, retype once.
  await sleep(400);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.keyboard.type(text, { delay: 15 });
    if (!panelId) break;
    const typed = await until(async () => squeeze(nonEmpty(await screenText(panelId)).slice(-4).join('')).endsWith(squeeze(text)), 3000, 200);
    if (typed) break;
    log(`the typed line didn't arrive whole; retyping (attempt ${attempt + 2})`);
    await page.keyboard.press('Control+C');
    await sleep(800);
  }
  if (enter) await page.keyboard.press('Enter');
}
// The last screen row where `command` ends. A long prompt plus command wraps over several rows (DROP 1 D5: the
// worktree prompt pushed the command past the terminal width), so up to 4 consecutive rows are joined.
// Whitespace is ignored: a row that wraps right after a space loses that space to the trim (rehearsal D2).
const squeeze = (text) => text.replace(/\s+/g, '');
function commandEnd(lines, command) {
  const wanted = squeeze(command);
  for (let end = lines.length - 1; end >= 0; end--) {
    for (let start = end; start >= Math.max(0, end - 3); start--) {
      // It ends on `end`: the rows up to `end` hold it, the rows before `end` alone don't.
      if (squeeze(lines.slice(start, end + 1).join('')).includes(wanted) && !squeeze(lines.slice(start, end).join('')).includes(wanted)) return end;
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
  await typeInVisibleTerminal(command, { panelId });
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
// E5 has ONE startup script for every sandbox and saving it runs it on every running sandbox: with another sandbox up
// (Red's testina) a save would run the kit's script there. Every save is refused while any other row is active.
async function otherActiveSandboxes() {
  const rows = page.getByRole('listitem', { name: /^Cloud sandbox / });
  const active = [];
  for (const row of await rows.all()) {
    const label = ((await row.getAttribute('aria-label').catch(() => '')) ?? '').replace(/^Cloud sandbox /, '');
    const text = ((await row.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    if (label && label !== state.label && /(^|\s)(Running|Starting|Stopping|Creating|Updating|Saving)(\s|$)/.test(text)) active.push(label);
  }
  return active;
}
async function guardStartupScriptSave(what) {
  const others = await otherActiveSandboxes();
  check(`no-other-sandbox-running-before-${what}`, others.length === 0, others.length ? `refusing to save the startup script: it would run on ${others.join(', ')}` : 'no other sandbox is active');
  if (others.length) throw new Error(`another sandbox is active (${others.join(', ')}); the startup script was NOT saved (stop it first)`);
}

async function d0() {
  await openCloud();
  await guardStartupScriptSave('d0');
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
  if (cloud) {
    const tokenStatus = ((await ui.githubTokenStatus().innerText().catch(() => '')) || '').trim();
    results.githubTokenStatusBeforeAdd = tokenStatus;
    if (relay) check('github-token-set', tokenStatus === 'Set', `GitHub token: ${tokenStatus || 'unread'}`);
    else check('github-token-not-set', tokenStatus !== 'Set', `GitHub token: ${tokenStatus || 'unread'} (a rehearsal carries no GitHub credential)`);
    await inView('github-token-status', ui.githubTokenStatus());
    await shot('github-token-status');
  }
  // D0_DRY=1: everything up to the Add click (0 starts), to prove the editor and the credentials before spending one.
  if (env.D0_DRY === '1') {
    await ui.nameInput().fill('rp-loop-cs-e2e-dry');
    check('add-button-ready', await ui.addSandbox().isEnabled(), 'Add cloud sandbox enabled (not clicked: D0_DRY)');
    // DRY_SAVE_DUMMY=1: the dummy token's save path, in this throwaway profile only.
    if (env.DRY_SAVE_DUMMY === '1') {
      await ui.githubTokenField().fill(DUMMY_GITHUB_TOKEN);
      await ui.saveGithubToken().click();
      const set = await until(async () => ((await ui.githubTokenStatus().innerText().catch(() => '')) || '').trim() === 'Set', 60_000, 1000);
      check('dry-dummy-token-saved', Boolean(set), `Saved token: ${((await ui.githubTokenStatus().innerText().catch(() => '')) || '').trim()}`);
      const leftover = (await page.locator('input, textarea').evaluateAll((inputs) => inputs.map((input) => input.value))).includes(DUMMY_GITHUB_TOKEN);
      check('dry-token-not-shown-after-save', !leftover, 'no field holds the token after saving');
      await shot('dry-dummy-token-saved');
    }
    await shot('dry-before-add');
    await ui.nameInput().fill('');
    return;
  }

  // E6 (D2, Red 12:21): Red pastes his GitHub token into Settings BEFORE Add; the kit takes no screenshot meanwhile.
  if (relay && env.SKIP_GITHUB_TOKEN !== '1') {
    await inView('github-token-section', ui.githubTokenField());
    const saved = await waitForFlag('github-token-saved', 'In the Pane window (Settings > Remote Access, already open): paste your GitHub token (fine-grained: montlakev2, Contents + Pull requests Read and write) into the "GitHub token" box, then click "Save GitHub Token". "Saved token" then reads Set. Do not type it anywhere else.');
    check('github-token-flag', saved, 'Red saved the GitHub token');
    const registered = registerSavedCredentials().filter((entry) => /github/i.test(entry));
    // For the auditor's exact-value scan: length and sha256[:12] only, computed here on SOBECK.
    results.githubToken = registered.map((entry) => ({ entry: entry.replace(/^.*?\(/, '(') }));
    log(`GitHub token registered for the exact-value scan: ${registered.join(', ') || 'none found in the saved credentials'}`);
    check('github-token-registered-for-scan', registered.length > 0, registered.length ? 'by name, length and sha256[:12] only' : 'the saved credentials hold no GitHub token');
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
      await inView('startup-progress-line', ui.progress(state.label).getByText(/Running your startup script…/));
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
  await inView('row-running', ui.row(state.label));
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
    // A Windows host's terminal may be PowerShell (DOMAIN\user, a Path table) or Git Bash (user, /d/a/... paths).
    const posix = (text) => text.trim().replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).toLowerCase();
    const user = expected.user.toLowerCase();
    check('whoami', lines.some((line) => [user].includes(line.trim().toLowerCase()) || line.trim().toLowerCase().endsWith(`\\${user}`)), lines.join(' | '));
    check('hostname', lines.some((line) => expected.hostname.test(line.trim())), lines.join(' | '));
    check('pwd-home', lines.some((line) => posix(line) === posix(expected.home)), lines.join(' | '));
  } else {
    const [user, hostname, cwd] = lines;
    check('whoami', user?.trim() === expected.user, `${user} (want ${expected.user})`);
    check('hostname', expected.hostname.test(hostname?.trim() ?? ''), `${hostname} (want ${expected.hostname})`);
    check('pwd-home', cwd?.trim() === expected.home, `${cwd} (want ${expected.home})`);
  }
  await shot('host-terminal-whoami', { result: true, oracle: { panelId, lines } });
  // K1: a time mark on the host before any sign-in; later no browser profile may be newer than it.
  await runInTerminal(panelId, `touch ${SIGN_IN_MARK}`);
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
  // D3's clone lands in a new folder ~/e2e-d3 made with the picker (New folder is offered for a Clone destination), so
  // D4 can still clone the same repo into ~ itself (cs-e2e E3 v2 contract, sequencing note).
  await dialog.getByRole('button', { name: /^Browse/ }).click();
  const picker = ui.picker(state.label);
  await picker.waitFor({ timeout: 10_000 });
  check('clone-picker-offers-new-folder', await visible(ui.pickerNewFolder(picker), 3000), '"New folder" in the Clone browser');
  await ui.pickerNewFolder(picker).click();
  await picker.getByLabel('New folder name').fill(D3_FOLDER);
  await picker.getByRole('button', { name: 'Create folder', exact: true }).click();
  if (await visible(ui.pickerEntry(picker, D3_FOLDER, false), 5000)) await ui.pickerEntry(picker, D3_FOLDER, false).click();
  const inFolder = await until(async () => ((await ui.pickerCurrent(picker).first().innerText().catch(() => '')) || '').trim() === hostPath(expected.home, D3_FOLDER), 10_000, 300);
  check('clone-picker-new-folder', Boolean(inFolder), `Current folder ${hostPath(expected.home, D3_FOLDER)}`);
  await shot('clone-picker-new-folder');
  await ui.pickerConfirm(picker).click();
  await picker.waitFor({ state: 'hidden', timeout: 5000 });
  check('clone-destination-new-folder', samePath(await dialog.getByLabel('Destination').inputValue(), hostPath(expected.home, D3_FOLDER)), await dialog.getByLabel('Destination').inputValue());
  await dialog.getByRole('button', { name: /^Clone/ }).last().click();
  // E6: with a token the clone simply works; without one a cloud sandbox points to Settings.
  const outcome = await until(async () => {
    if ((await projectsOnHost()).some((project) => samePath(project.path, hostPath(expected.home, D3_FOLDER, 'montlakev2')))) return 'cloned';
    if (await visible(ui.addTokenNotice(), 200)) return 'add-token';
    if (await visible(ui.signInAlert(page, state.label), 200)) return 'sign-in';
    return undefined;
  }, 300_000, 1500);
  log(`D3 clone outcome: ${outcome ?? 'none'}`);
  if (outcome === 'cloned') return d3Cloned();
  if (outcome === 'add-token') return d3AddToken();
  const alert = ui.signInAlert(page, state.label);
  check('sign-in-error-shown', await visible(alert, 60_000), `"${state.label} isn't signed in to GitHub."`);
  check('sign-in-error-buttons', await visible(ui.signInOpenTerminal(state.label), 1000) && await visible(ui.tryAgain(), 1000), 'Open terminal … to sign in + Try again');
  await inView('sign-in-alert', alert);
  // E3.9: the fallback's hint, so the user signs in from their own computer.
  check('sign-in-hint', await visible(page.getByText(/Open github\.com\/login\/device on your computer/), 2000), '"Open github.com/login/device on your computer, enter the code, and wait here."');
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
  check('prefill-typed-not-submitted', Boolean(shown) && lastLine.trimEnd().endsWith(GH_PREFILL) && !lastLine.trimEnd().startsWith(GH_PREFILL),
    `last line: ${lastLine}`);
  await sleep(1000);
  await shot('terminal-prefilled', { result: true, oracle: { panelId, lastLines: (shown ?? []).slice(-4) } });
  // Nothing ran: still the same a few seconds later.
  await sleep(3000);
  check('prefill-still-unsubmitted', nonEmpty(await screenText(panelId)).at(-1) === lastLine, 'no output appeared');

  // E3 v2: back to Home > GitHub (the draft and the notice are kept), then the in-app sign-in.
  const again = await openCloneDialog();
  const urlKept = Boolean(await until(async () => (await again.getByLabel('Repository URL').inputValue()) === PRIVATE_REPO, 5000, 250));
  const noticeKept = await visible(ui.signInAlert(page, state.label), 15_000);
  check('draft-kept-after-terminal', urlKept && noticeKept, `URL kept ${urlKept}, notice back ${noticeKept}`);
  if (!(urlKept && noticeKept)) await shot('draft-after-terminal');
  if (env.D3V2 === '0' || !(await visible(ui.signInGitHub(), 3000))) {
    // Before E3 v2 (drop 6): only the fallback exists. Run 8 needs it.
    check('sign-in-to-github-offered', relay ? false : null, 'no "Sign in to GitHub" in this build');
    await closeMenus();
    return;
  }
  await d3SignIn(again);
}

// E6 with a token (Run 8): the clone works with no sign-in step at all.
async function d3Cloned() {
  check('clone-with-token-works', true, `montlakev2 cloned into ${hostPath(expected.home, D3_FOLDER)}`);
  check('no-sign-in-step', !(await visible(ui.signInAlert(page, state.label), 300)) && !(await visible(ui.addTokenNotice(), 300))
    && !(await visible(ui.hostTerminalTab(state.label), 300)) && (await ui.deviceCode().count()) === 0, 'no notice, no terminal, no device code');
  await visible(ui.openMainWorkspace('montlakev2'), 30_000);
  await shot('d3-cloned-with-token', { result: true, oracle: { projects: await projectsOnHost() } });
}

// E6 without a token (rehearsal): "Add a GitHub token in Settings" + Open Settings shows the field; then a DUMMY token is
// saved through the UI so D7 can prove "⚠ GitHub token invalid" after Start.
async function d3AddToken() {
  check('add-token-notice', true, '"Add a GitHub token in Settings"');
  check('add-token-no-terminal-fallback', !(await visible(ui.signInOpenTerminal(state.label), 300)), 'a cloud sandbox is not sent to the terminal');
  await inView('add-token-notice', ui.addTokenNotice());
  await shot('clone-add-token-notice', { result: true });
  await ui.openSettingsForToken().click();
  check('open-settings-shows-token-field', await visible(ui.settingsDialog(), 10_000) && await inView('github-token-field', ui.githubTokenField()), 'Settings opened at the GitHub token');
  const focused = Boolean(await until(() => ui.githubTokenField().evaluate((element) => element === document.activeElement), 3000, 200));
  check('open-settings-focuses-token-field', focused, focused ? 'the GitHub token box has the focus' : 'not focused');
  await shot('settings-github-token', { result: true });
  if (relay || env.DUMMY_GITHUB_TOKEN === '0') return;
  addSecret('dummyGithubToken', DUMMY_GITHUB_TOKEN);
  await ui.githubTokenField().fill(DUMMY_GITHUB_TOKEN);
  await ui.saveGithubToken().click();
  const set = await until(async () => ((await ui.githubTokenStatus().innerText().catch(() => '')) || '').trim() === 'Set', 60_000, 1000);
  check('dummy-token-saved', Boolean(set), 'GitHub token: Set (a dummy, to prove the invalid-token row)');
  const shown = (await page.locator('input, textarea').evaluateAll((inputs) => inputs.map((input) => input.value))).includes(DUMMY_GITHUB_TOKEN);
  check('token-not-shown-after-save', !shown, 'no input holds the token after saving');
  await shot('dummy-token-saved');
  state.dummyToken = true;
  saveState();
  await closeSettings();
}

// E6 D2 (Run 8): the token Red saved before Add signed the sandbox in; then Red's Codex device login (code masked).
async function d2Token() {
  await openCloud();
  const signedIn = await until(async () => (await visible(ui.rowGithubSignedIn(state.label), 500)) && await ui.rowGithubSignedIn(state.label).innerText(), 120_000, 2000);
  check('row-github-signed-in', Boolean(signedIn), signedIn || `row: ${await rowText(state.label)}`);
  await inView('row-github', ui.row(state.label));
  await shot('row-github-signed-in', { result: Boolean(signedIn) });
  await closeSettings();
  const panelId = await openHostTerminalFromSwitcher(state.label);
  const { lines } = await runInTerminal(panelId, 'gh auth status', { timeoutMs: 60_000 });
  check('gh-auth-status-logged-in', lines.some((line) => /Logged in to github\.com/i.test(line)), lines.filter((line) => /github\.com|Logged/i.test(line)).join(' | '));
  const { lines: hostsMode } = await runInTerminal(panelId, 'echo HOSTS_MODE=$(stat -c %a ~/.config/gh/hosts.yml 2>/dev/null || echo none)');
  check('gh-hosts-file-0600', /HOSTS_MODE=600\b/.test(hostsMode.join(' ')), hostsMode.join(' ').match(/HOSTS_MODE=\S+/)?.[0] ?? 'unread');
  await shot('gh-auth-status', { result: true, oracle: { lines, hostsMode } });
  await codexSignIn(panelId);
}

async function codexSignIn(panelId) {
  // From the Enter on, the terminal counts as showing a code (masked in shots, cut from the video) until it is cleared,
  // whether or not the code's format is recognised: a WebGL terminal's text is invisible to the DOM backstops.
  await typeInVisibleTerminal('codex login --device-auth', { panelId });
  codeShown('codexDeviceCode', undefined);
  const codexShown = await until(async () => {
    const text = nonEmpty(await screenText(panelId)).slice(-12).join('\n');
    const codexCode = /https:\/\//.test(text) ? deviceCodeIn(text) : undefined;
    if (codexCode) codeShown('codexDeviceCode', codexCode);
    return codexCode;
  }, 60_000, 1000);
  check('codex-device-code-shown', Boolean(codexShown), codexShown ? 'Codex shows a URL and a one-time code (masked)' : 'no Codex code');
  await shot('codex-code-and-url', { result: true });
  const codexFlag = await waitForFlag('codex-signed-in', `In YOUR browser open the URL shown in the "${state.label} · Terminal" tab, enter the code shown there, and approve. Then wait until that terminal is back at its prompt. Do NOT press Ctrl-C.`);
  check('codex-flag', codexFlag, 'Red finished the Codex sign-in');
  const codexDone = await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 300_000, 1500);
  check('codex-completed-without-ctrl-c', Boolean(codexDone), codexDone ? 'the prompt came back' : 'codex login did not finish within 5 min of the flag');
  if (!codexDone) await page.keyboard.press('Control+C');
  await codeCleared(panelId);
  const { lines } = await runInTerminal(panelId, 'codex login status', { timeoutMs: 60_000 });
  const text = lines.join('\n');
  check('codex-logged-in', /Logged in using/i.test(text), lines.filter((line) => /^\s*(Logged in using|Not logged in)/i.test(line)).join(' | ') || 'no codex status line');
  check('no-token-text', tokenShapes(text).length === 0, `token shapes: ${JSON.stringify(tokenShapes(text))}`);
  await shot('signed-in-status', { result: true, oracle: { panelId, lines } });
}

// The in-app device flow (E3 v2): code screen (code masked), local link, Red approves (SOBECK; a rehearsal cancels),
// "Signed in to GitHub as <user>" with no terminal and no Ctrl-C, Try again clones, then gh auth status on the host.
async function d3SignIn(dialog) {
  startBrowserSampler('in-app-sign-in');
  await ui.signInGitHub().click();
  const code = await until(async () => (await ui.deviceCode().first().innerText().catch(() => '')).trim() || undefined, 60_000, 500);
  // Exactly one code element: mask it; anything else: mask the whole dialog. Marked only when a code really appeared.
  if (code) codeShown('ghDeviceCode', code, async () => ((await ui.deviceCode().count().catch(() => 0)) === 1 ? [ui.deviceCode()] : [dialog]));
  check('in-app-device-code', Boolean(code), code ? 'a device code is shown in Pane (masked in all evidence)' : 'no code');
  check('in-app-copy-and-link', await visible(ui.copyCode(), 2000) && await visible(ui.openDeviceLink(), 2000), '"Copy" + "Open github.com/login/device" next to the code');
  check('in-app-waiting', await visible(page.getByText('Waiting for you to approve on GitHub…'), 5000), '"Waiting for you to approve on GitHub…"');
  check('no-terminal-for-sign-in', !(await visible(ui.hostTerminalTab(state.label), 500)) || (await dialog.isVisible()), 'the sign-in stays in the dialog');
  await shot('in-app-code', { result: true });
  check('code-masked-in-shot', await maskedInShot(current.shots.at(-1).file, ui.deviceCode().first()), 'every pixel where the code sits in the saved shot is the mask colour');
  if (mode === 'live' && state.cloud?.sandboxId) {
    const { stdout } = await boatExec(state.cloud.sandboxId, boatOrg, `ps -eo comm= | grep -ciE '${BROWSER_PATTERN}' || true`).catch(() => ({ stdout: '' }));
    const during = Number(String(stdout).trim().split('\n').at(-1));
    check('no-browser-while-waiting', during === 0, `browser processes on the sandbox while gh waits (boat exec ps): ${during}`);
  }
  if (!relay && env.D3V2_COMPLETE !== '1') {
    // Rehearsal: no real sign-in. Cancel, and the code is gone.
    await ui.deviceCodePanel().getByRole('button', { name: 'Cancel', exact: true }).click();
    check('in-app-cancel', await ui.deviceCode().first().waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false), 'the code is gone after Cancel');
    codeHidden();
    stopBrowserSampler();
    await shot('in-app-cancelled');
    return;
  }
  // The link opens on THIS computer (the desktop hands it to the OS), never on the host.
  const before = (await app.evaluate(() => globalThis.__e2eOpened.slice())).length;
  await ui.openDeviceLink().click();
  const opened = await until(async () => (await app.evaluate(() => globalThis.__e2eOpened.slice())).slice(before).find((url) => /github\.com\/login\/device/.test(url)), 10_000, 300);
  check('device-link-opens-locally', Boolean(opened), opened ? `the desktop opened ${opened}` : 'nothing opened locally');
  const approved = await waitForFlag('gh-signed-in', 'In the browser that just opened ON THIS PC (github.com/login/device), enter the code shown in the Pane window (use its Copy button) and approve. Then wait until Pane shows "Signed in to GitHub as …". Nothing to type in any terminal.');
  check('gh-flag', approved, 'Red approved on github.com');
  const signedIn = await until(async () => (await visible(ui.signedInAs(), 500)) && await ui.signedInAs().first().innerText(), 300_000, 1500);
  check('signed-in-in-app', /Signed in to GitHub as \S+/.test(signedIn ?? ''), signedIn ?? 'no "Signed in to GitHub as …"');
  if (!(await visible(ui.deviceCode(), 300))) codeHidden();
  check('signed-in-without-terminal', !(await visible(ui.hostTerminalTab(state.label).filter({ has: page.locator('[aria-selected="true"]') }), 300)), 'no terminal was needed');
  await inView('signed-in', ui.signedInAs());
  await shot('signed-in-as', { result: true });
  await ui.tryAgain().click();
  const cloned = await until(async () => (await projectsOnHost()).find((project) => samePath(project.path, hostPath(expected.home, D3_FOLDER, 'montlakev2'))), 300_000, 2000);
  check('try-again-clones', Boolean(cloned), JSON.stringify(cloned ?? null));
  await shot('d3-cloned', { result: Boolean(cloned), oracle: { cloned } });
  stopBrowserSampler();
  const panelId = await openHostTerminalFromSwitcher(state.label);
  const { lines } = await runInTerminal(panelId, 'gh auth status', { timeoutMs: 60_000 });
  check('gh-auth-status-logged-in', lines.some((line) => /Logged in to github\.com/i.test(line)), lines.filter((line) => /github\.com|Logged/i.test(line)).join(' | '));
  await shot('gh-auth-status', { result: true, oracle: { lines } });
  const browsers = await browserProcesses(panelId, 'after-in-app-sign-in');
  check('no-browser-on-host', browsers.count === 0, `browser processes on the host: ${browsers.count}`);
  // E3v2-KEYRING (Red 12:19): on a sandbox gh stores its token in hosts.yml (--insecure-storage), with no keyring prompt.
  // Only the file's MODE and a prompter count are read, never its contents.
  const { lines: keyring } = await runInTerminal(panelId, "echo PROMPTERS=$(pgrep -c 'gcr-prompter|pinentry|gnome-keyring' || true) HOSTS_MODE=$(stat -c %a ~/.config/gh/hosts.yml 2>/dev/null || echo none)");
  const keyText = keyring.join(' ');
  check('no-keyring-prompt', /PROMPTERS=0\b/.test(keyText), keyText.match(/PROMPTERS=\S+/)?.[0] ?? 'unread');
  if (cloud) check('gh-hosts-file-0600', /HOSTS_MODE=600\b/.test(keyText), keyText.match(/HOSTS_MODE=\S+/)?.[0] ?? 'unread');
  await shot('keyring-and-hosts-mode', { oracle: { keyring } });
  state.ghSignedInByD3 = true;
  saveState();
}

// ---------------------------------------------------------------- D2: Red signs the host in (SOBECK)
// Red's rule (12:07 PT): no browser may open ON the host; gh only prints the code and the URL, and completes WITHOUT
// Ctrl-C. Device codes never reach the evidence: they are redacted from text, shots mask the terminal while one is on
// screen, the user then clears the screen, and the video intervals that showed one are cut out at the end.
const BROWSER_PATTERN = 'chrom|firefox|xdg-open|sensible-browser|x-www-browser|git-credential-manager';
const codeIntervals = [];
let codeOnScreenSince = null;
// What a shot masks while a code is on screen: the terminal by default, the code element for the in-app flow.
let codeMask = async () => [page.locator('.xterm:visible')];
function codeShown(name, code, mask) {
  if (code) addSecret(name, code);
  if (mask) codeMask = mask;
  if (codeOnScreenSince === null) codeOnScreenSince = videoAt();
}
function codeHidden() {
  if (codeOnScreenSince !== null) codeIntervals.push([codeOnScreenSince, videoAt()]);
  codeOnScreenSince = null;
  codeMask = async () => [page.locator('.xterm:visible')];
}
async function codeCleared(panelId) {
  // Like a user, before anything else is shown: wipe the code off the window (screen and scrollback).
  await page.locator('.xterm:visible').last().click();
  await page.keyboard.type('clear', { delay: 15 });
  await page.keyboard.press('Enter');
  await until(async () => nonEmpty(await screenText(panelId)).length <= 1, 10_000, 300);
  await sleep(800);
  codeHidden();
}
// The host's browser processes as the user can see them, typed in the host terminal; on a sandbox boat exec counts them too.
async function browserProcesses(panelId, what) {
  const { lines } = await runInTerminal(panelId, `echo BROWSERS=$(pgrep -fci '${BROWSER_PATTERN}'); pgrep -fil '${BROWSER_PATTERN}' | cut -c1-60`);
  const count = Number(lines.join('\n').match(/BROWSERS=(\d+)/)?.[1] ?? NaN);
  // A browser that started and exited still leaves its profile: none may be newer than the D1 mark.
  const { lines: profileLines } = await runInTerminal(panelId, `echo PROFILES=$(find ~/.config ~/.cache ~/.mozilla ~/snap ~/.gcm -maxdepth 2 -newer ${SIGN_IN_MARK} \\( -iname '*chrom*' -o -iname '*firefox*' -o -iname '.mozilla' -o -iname '*gcm*' -o -iname 'git-credential-manager' \\) 2>/dev/null | wc -l)`);
  const profiles = Number(profileLines.join('\n').match(/PROFILES=(\d+)/)?.[1] ?? NaN);
  check(`no-browser-profile-${what}`, profiles === 0, `browser/GCM profile dirs newer than the D1 mark: ${profiles}`);
  let boat = null;
  if (mode === 'live' && state.cloud?.sandboxId) {
    const { stdout } = await boatExec(state.cloud.sandboxId, boatOrg, `ps -eo comm= | grep -ciE '${BROWSER_PATTERN}' || true`).catch(() => ({ stdout: '' }));
    boat = Number(String(stdout).trim().split('\n').at(-1));
  }
  await shot(`browsers-${what}`, { oracle: { count, boat, lines } });
  return { count, boat, lines };
}
const SIGN_IN_MARK = '/tmp/e2e-before-sign-in';
const DEVICE_CODE_SHAPE = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/;
// Backstop for the video: once a second, any device-code-shaped text in the window (or the code element) opens an
// interval that is cut out of the recording, whether or not the kit's own steps flagged it.
let codeWatch = null;
function startCodeWatch() {
  let since = null;
  const timer = setInterval(async () => {
    const shown = await page.evaluate((source) => {
      const shape = new RegExp(source);
      return shape.test(document.body?.innerText ?? '') || Boolean(document.querySelector('[data-secret="github-device-code"], [aria-label="One-time code"]'));
    }, DEVICE_CODE_SHAPE.source).catch(() => false);
    if (shown && since === null) since = videoAt();
    if (!shown && since !== null) {
      codeIntervals.push([since, videoAt()]);
      since = null;
    }
  }, 1000);
  codeWatch = { timer, open: () => since };
}
function stopCodeWatch() {
  if (!codeWatch) return;
  clearInterval(codeWatch.timer);
  if (codeWatch.open() !== null) codeIntervals.push([codeWatch.open(), null]);
  codeWatch = null;
}
// K1 (live only): boat exec counts browser processes on the sandbox every 2 s over a sign-in window, counts only.
let sampler = null;
function startBrowserSampler(what) {
  if (mode !== 'live' || !state.cloud?.sandboxId) return;
  const samples = [];
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const { stdout } = await boatExec(state.cloud.sandboxId, boatOrg, `ps -eo comm= | grep -ciE '${BROWSER_PATTERN}' || true`, 15).catch(() => ({ stdout: 'x' }));
    samples.push(Number(String(stdout).trim().split('\n').at(-1)));
    busy = false;
  }, 2000);
  sampler = { what, samples, timer };
}
function stopBrowserSampler() {
  if (!sampler) return;
  clearInterval(sampler.timer);
  const read = sampler.samples.filter((value) => Number.isFinite(value));
  check(`no-browser-sampled-${sampler.what}`, read.length > 0 && read.every((value) => value === 0), `${read.length} samples (every 2 s), max ${Math.max(0, ...read)}, unreadable ${sampler.samples.length - read.length}`);
  results.browserSamples = { ...(results.browserSamples ?? {}), [sampler.what]: { samples: read.length, max: Math.max(0, ...read) } };
  sampler = null;
}
const deviceCodeIn = (text) => text.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/)?.[1];

async function d2() {
  if (cloud && relay) return d2Token();
  const panelId = state.hostTerminalPanelId ?? await openHostTerminalFromSwitcher(state.label);
  if (!(await visible(ui.hostTerminalTab(state.label), 1000))) await openHostTerminalFromSwitcher(state.label);
  const ghLast = nonEmpty(await screenText(panelId)).at(-1) ?? '';
  check('gh-prefill-present', ghLast.trimEnd().endsWith(GH_PREFILL), `last line: ${ghLast}`);
  // The baseline needs the prompt free: it is read from a boat exec only (live); the typed count follows the sign-in.
  startBrowserSampler('fallback-sign-in');
  // The user presses Enter on the prefilled line (D3), then answers gh's questions with their defaults.
  await page.locator('.xterm:visible').last().click();
  await page.keyboard.press('Enter');
  codeShown('ghDeviceCode', undefined);
  let code;
  const shown = await until(async () => {
    const text = nonEmpty(await screenText(panelId)).slice(-8).join('\n');
    if (/one-time code/i.test(text)) {
      code = deviceCodeIn(text.split(/one-time code/i).at(-1) ?? '');
      codeShown('ghDeviceCode', code);
      return true;
    }
    const last = text.split('\n').at(-1) ?? '';
    if (/^\s*\?\s/.test(last)) await page.keyboard.press('Enter');
    return undefined;
  }, 90_000, 1500);
  check('gh-device-code-shown', Boolean(shown && code), shown ? 'gh shows a one-time code (masked in all evidence)' : 'no one-time code');
  // "Press Enter to open github.com in your browser": the key a user presses. With the fix gh opens nothing on the host.
  if (/Press Enter to open/i.test(nonEmpty(await screenText(panelId)).slice(-4).join('\n'))) await page.keyboard.press('Enter');
  await sleep(8000);
  const screenAfterEnter = nonEmpty(await screenText(panelId)).slice(-8);
  check('gh-prints-url', screenAfterEnter.some((line) => /github\.com\/login\/device/.test(line)), 'the github.com/login/device URL is printed');
  await shot('gh-code-and-url', { result: true, oracle: { lastLines: screenAfterEnter } });
  if (mode === 'live' && state.cloud?.sandboxId) {
    const { stdout } = await boatExec(state.cloud.sandboxId, boatOrg, `ps -eo comm= | grep -ciE '${BROWSER_PATTERN}' || true`).catch(() => ({ stdout: '' }));
    const during = Number(String(stdout).trim().split('\n').at(-1));
    check('no-browser-while-gh-waits', during === 0, `browser processes on the sandbox while gh waits (boat exec ps): ${during}`);
  }
  if (!relay && env.D2_COMPLETE !== '1') {
    // Rehearsal: no real sign-in. Cancelled here (the only Ctrl-C), then the screen is cleared and the host checked.
    await page.keyboard.press('Control+C');
    await until(async () => promptLine.test(nonEmpty(await screenText(panelId)).at(-1) ?? ''), 10_000, 300);
    await codeCleared(panelId);
    stopBrowserSampler();
    const after = await browserProcesses(panelId, 'after-gh-cancel');
    check('no-browser-on-host', after.count === 0 && (after.boat === null || after.boat === 0), `typed count ${after.count}, boat exec ${after.boat ?? '-'}: ${after.lines.slice(1, -1).join(' | ') || 'none'}`);
    check('gh-sign-in-rehearsed', true, 'code + URL printed, no browser; cancelled (no real sign-in in a rehearsal)');
    return;
  }
  const ghFlag = await waitForFlag('gh-signed-in', `In YOUR browser (on this PC) open https://github.com/login/device, enter the one-time code shown in the Pane window's "${state.label} · Terminal" tab, and approve. Then wait until that terminal shows "Logged in as" and is back at its prompt. Do NOT press Ctrl-C.`);
  check('gh-flag', ghFlag, 'Red finished the GitHub sign-in');
  // gh completes by itself: "Logged in as …" and the prompt back, with no Ctrl-C from anyone.
  const done = await until(async () => {
    const lines = nonEmpty(await screenText(panelId)).slice(-12);
    return lines.some((line) => /Logged in as/i.test(line)) && promptLine.test(lines.at(-1) ?? '') ? lines : undefined;
  }, 300_000, 1500);
  check('gh-completed-without-ctrl-c', Boolean(done), done ? '"Logged in as …" and the prompt came back; the kit sent no Ctrl-C' : 'gh did not finish within 5 min of the flag');
  await shot('gh-logged-in', { result: Boolean(done), oracle: { lastLines: done ?? nonEmpty(await screenText(panelId)).slice(-12) } });
  if (!done) {
    await page.keyboard.press('Control+C');
    check('gh-needed-ctrl-c', false, 'the kit had to cancel gh to go on');
  }
  await codeCleared(panelId);
  const afterGh = await browserProcesses(panelId, 'after-gh');
  check('no-browser-on-host', afterGh.count === 0, `browser processes on the host after the sign-in: ${afterGh.count} ${afterGh.lines.slice(1, -1).join(' | ')}`);

  await codexSignIn(panelId);
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
  await inView('windows-path-alert', add.getByText(sentence, { exact: false }));
  await shot('windows-path-rejected', { result: true, oracle: { projectsBefore: before.length, projectsAfter: after.length } });
  await add.getByRole('button', { name: 'Cancel', exact: true }).click();
}

async function d4OpenAndNew() {
  // (c) An existing repo on the host (put there from the host terminal) opened through the remote picker.
  const panelId = await openHostTerminalFromSwitcher(state.label);
  // `"$HOME/…"` and `;` mean the same in bash and PowerShell (a Windows self-hosted host).
  const { lines: cloneLines } = await runInTerminal(panelId, `git clone -q ${OPEN_REPO_URL} "$HOME/${openRepoDir}"; echo clone_exit=$?`, { timeoutMs: 180_000, done: (text) => /clone_exit=/.test(text) });
  check('open-repo-cloned-on-host', cloneLines.some((line) => /clone_exit=(0|True)\b/.test(line)), cloneLines.join(' | '));
  await shot('open-repo-on-host');
  const add = await openRepositoryDialog();
  await sleep(500);
  await add.getByRole('button', { name: /^Browse/ }).click();
  const openPicker = ui.picker(state.label);
  // windows-latest: the first click during the dialog's opening didn't show the browser within 10 s.
  if (!(await visible(openPicker, 10_000))) {
    log('the folder browser did not open; clicking Browse again');
    await add.getByRole('button', { name: /^Browse/ }).click();
  }
  await openPicker.waitFor({ timeout: 30_000 });
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
  // K2: D3 may have cloned a second project with the same name (~/e2e-d3/montlakev2); the one used is D4's, at
  // ~/<repo>. The sidebar lists projects in the host's order, so its row is picked by that index and checked below.
  const sameName = (await projectsOnHost()).filter((project) => project.name === repo);
  const index = Math.max(0, sameName.findIndex((project) => samePath(project.path, hostPath(expected.home, repo))));
  state.repoIndex = index;
  saveState();
  await ui.openMainWorkspace(repo).nth(index).click();
  await ui.newPaneIn(repo).nth(index).click();
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
  check('pane-in-d4-project', String(session.worktreePath ?? '').startsWith(`${hostPath(expected.home, repo)}${hostIsWindows ? '\\' : '/'}`), `${session.worktreePath} is under ${hostPath(expected.home, repo)} (row ${index + 1} of ${sameName.length} named ${repo})`);
  // `git worktree list` rows can wrap: judged on the rows joined.
  const listed = new RegExp(`${escapeRegExp(session.worktreePath)}\\s+[0-9a-f]{7,}\\s+\\[${escapeRegExp(branch ?? '')}\\]`).test(worktrees.join(''));
  check('pane-branch', Boolean(branch) && listed, `branch ${branch}; worktree list ${JSON.stringify(worktrees)}`);
  await shot('pane-terminal-worktree', { result: true, oracle: { session: state.pane, lines } });
  // LINK_SELFTEST=1: D8's link click on a URL printed in this terminal (it only records the URL outside SOBECK).
  if (env.LINK_SELFTEST === '1') {
    const url = 'https://github.com/jamari-morrison/montlakev2/pull/1';
    await runInTerminal(panelId, `echo ${url}`);
    const opened = await clickTerminalLink(/github\.com\/jamari-morrison\/montlakev2\/pull\/\d+/);
    check('link-click-selftest', opened === url, `the click opened ${opened ?? 'nothing'}`);
  }
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
  await inView('row-with-open-terminal', ui.row(state.label));
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
  await inView('row-stopped', ui.row(state.label));
  await shot('row-stopped', { result: true });

  countStart('start');
  await ui.rowAction('Start', state.label).click();
  let sawOpenTerminalWhileStarting = false;
  const running = await until(async () => {
    const row = await rowText(state.label);
    if (!rowBadge(row, 'Running') && await visible(ui.rowOpenTerminal(state.label), 200)) sawOpenTerminalWhileStarting = true;
    return rowBadge(row, 'Running');
  }, 900_000, 1500);
  check('row-running-again', Boolean(running), await rowText(state.label));
  // E6 on Start: the token is applied again; the dummy one shows the warning, Red's real one signs in.
  if (state.dummyToken) {
    const invalid = await visible(ui.rowGithubInvalid(state.label), 180_000);
    check('row-github-token-invalid', invalid, invalid ? '"⚠ GitHub token invalid" on the row after Start' : `row: ${await rowText(state.label)}`);
    await inView('row-github-invalid', ui.row(state.label));
    await shot('row-github-token-invalid', { result: invalid });
  } else if (relay) {
    check('row-github-signed-in-after-start', await visible(ui.rowGithubSignedIn(state.label), 180_000), await rowText(state.label));
  }
  check('starting-hides-open-terminal', !sawOpenTerminalWhileStarting, 'no Open terminal until the row is Running again');
  await inView('row-running-again', ui.row(state.label));
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
  await d7FailingVariant();
}

async function d7FailingVariant() {
  await openCloud();
  await guardStartupScriptSave('failing-variant');
  await ui.startupScript().fill(`${startupScript}exit 1\n`);
  await ui.saveStartupScript().click();
  const chip = await until(async () => (await visible(ui.startupChip(state.label), 500)) && await ui.startupChip(state.label).innerText(), 660_000, 3000);
  check('failing-script-chip', /Startup script failed \(exit 1\)/.test(chip ?? ''), `chip: ${chip ?? 'none'}`);
  await inView('startup-chip', ui.startupChip(state.label));
  await shot('startup-chip', { result: true, oracle: { chip } });
  await ui.viewLog(state.label).click();
  const logDialog = ui.startupLog(state.label);
  check('view-log-dialog', await visible(logDialog, 10_000), `"Startup log: ${state.label}"`);
  // The dialog first says "Loading the log..." (rehearsal 2 read it then): wait for the log itself.
  const logText = await until(async () => {
    const text = (await logDialog.innerText().catch(() => '')) ?? '';
    return /Loading the log/i.test(text) ? undefined : text;
  }, 60_000, 500) ?? '';
  check('view-log-shows-run', logText.includes(MARKER), `${logText.split('\n').length} lines, marker ${logText.includes(MARKER)}`);
  check('view-log-no-token', tokenShapes(logText).length === 0, `token shapes in the shown log: ${JSON.stringify(tokenShapes(logText))}`);
  // The sandbox's startup log as the product shows it (last 200 lines), kept for the audit; redacted and scanned like all text.
  fs.writeFileSync(path.join(out, 'startup-log.txt'), `${redact(logText)}\n`);
  await shot('startup-log', { result: true });
  await page.keyboard.press('Escape');
}

async function d7ViewLogOnly() {
  await openCloud();
  const chip = (await visible(ui.startupChip(state.label), 3000)) ? await ui.startupChip(state.label).innerText() : '';
  check('chip-now', true, `chip: ${chip || 'none'}`);
  await inView('row', ui.row(state.label));
  await shot('row-now', { result: true, oracle: { chip } });
  if (!(await visible(ui.viewLog(state.label), 2000))) {
    check('view-log-available', false, 'no View log on the row now');
    return;
  }
  await ui.viewLog(state.label).click();
  const logDialog = ui.startupLog(state.label);
  const logText = await until(async () => {
    const text = (await logDialog.innerText().catch(() => '')) ?? '';
    return /Loading the log/i.test(text) ? undefined : text;
  }, 60_000, 500) ?? '';
  check('view-log-loaded', Boolean(logText), `${logText.split('\n').length} lines, marker ${logText.includes(MARKER)}, exit-1 run ${/exit 1|exit code 1|exited with 1/i.test(logText)}`);
  await shot('startup-log-loaded', { result: Boolean(logText), oracle: { lines: logText.split('\n').length, marker: logText.includes(MARKER) } });
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
  // The switcher after the last sandbox is gone: no entry for it (on an empty profile no switcher at all), and the
  // window is on This computer.
  await closeSettings();
  const others = savedHosts(paneDir).length;
  const chip = await visible(ui.switcherChip(), 3000);
  let stale = false;
  if (chip) {
    await openSwitcher();
    stale = await visible(ui.hostItem(state.label), 1000);
    await shot('switcher-after-remove');
    await closeMenus();
  }
  check('switcher-after-last-remove', !stale && (others > 0 || !chip), `switcher shown ${chip}, stale entry ${stale}, other saved hosts ${others}`);
  await goHome();
  await shot('home-after-remove', { result: true });
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
  if ((await otherActiveSandboxes()).length > 0) {
    results.regression.push({ name: 'startup-script-restored', verdict: 'FAIL', detail: 'NOT restored: another sandbox is active and a save would run it there; restore it by hand once it is stopped' });
    return;
  }
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
  // E6-c (auditor): the dummy GitHub token's exact value is in the exact-value scan from the start of every run that
  // may type it, reported only by name, length and sha256[:12].
  if (!relay) {
    addSecret('dummyGithubToken', DUMMY_GITHUB_TOKEN);
    log(`exact-value scan includes dummyGithubToken (len ${DUMMY_GITHUB_TOKEN.length}, sha256 ${crypto.createHash('sha256').update(DUMMY_GITHUB_TOKEN).digest('hex').slice(0, 12)})`);
  }
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
    // D2=1 (fake only): the flow up to the device codes, never completed (no flag), to prove the kit's prompt handling.
    await step('D2', 'Red signs the host in to GitHub and Codex (device codes)', d2, { applies: relay || env.D2 === '1', why: 'needs Red (SOBECK only)' });
    await step('D4', 'Clone via Home > GitHub; Windows path rejected; Open via the remote picker', d4);
    await step('D5', 'New Pane: its terminal is in the Pane\'s worktree', d5);
    await step('D6', 'Claude Code (and Codex) print pwd and branch = D5', d6);
    await step('D7', 'Startup status, Stop/Start re-runs it, a failing script shows the chip', d7, { applies: cloud, why: 'cloud sandboxes only' });
    // STEPS=D7LOG: only the row's View log, read again on a running sandbox (no edit, no start).
    // STEPS=D7FAIL: only the failing-script variant (an edit in the UI, no start).
    await step('D7FAIL', 'Failing startup script via the editor -> chip -> View log (loaded)', d7FailingVariant, { applies: cloud, why: 'cloud sandboxes only' });
    await step('D7LOG', 'View log on the row (re-observed: no edit, no start)', d7ViewLogOnly);
    await step('D8', 'Claude edits, commits, pushes and opens a draft PR', d8, { applies: relay || env.D8 === '1', why: 'needs Red\'s GitHub sign-in (SOBECK only)' });
  } finally {
    stopBrowserSampler();
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
