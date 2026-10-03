import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const SIGN_IN_COMMAND = 'gh auth login --web --git-protocol https && gh auth setup-git';
const REPO_URL = 'https://github.com/jamari-morrison/montlakev2';
const LOCAL_HTTPS_MESSAGE = 'Authentication failed — check your credentials or use an SSH URL.';

interface CloneProbe {
  cloneCalls: Array<[string, string]>;
  terminalInputs: Array<string | undefined>;
}

declare global {
  interface Window {
    __cloneProbe?: CloneProbe;
  }
}

/** Makes every clone fail the way the host's daemon reports a sign-in failure, and records clones and terminal opens. */
async function failClonesWithAuth(page: Page, error: string) {
  await page.evaluate((error) => {
    const probe: CloneProbe = { cloneCalls: [], terminalInputs: [] };
    window.__cloneProbe = probe;
    Object.assign(window.electronAPI.git, {
      cloneRepo: async (url: string, destDir: string) => {
        probe.cloneCalls.push([url, destDir]);
        return { success: false, error, code: 'GIT_CLONE_AUTH_REQUIRED' };
      },
    });
    window.addEventListener('pane:host-terminal-stub-open', (event) => {
      if (event instanceof CustomEvent) probe.terminalInputs.push(event.detail.input);
    });
  }, error);
}

async function connectRemote(page: Page) {
  await page.evaluate(async () => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'devbox', label: 'devbox', baseUrl: 'https://devbox.example.ts.net',
      token: 'synthetic', transport: 'http+sse',
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'devbox' });
  });
  await expect(page.getByRole('button', { name: 'Agents run on devbox. Switch host' })).toBeVisible();
}

async function fillAndClone(page: Page) {
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('https://github.com/user/repo').fill(REPO_URL);
  await dialog.getByRole('button', { name: 'Browse' }).click();
  await expect(dialog.getByPlaceholder('Select a destination folder...')).toHaveValue('/tmp/pane-worktrees');
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  return dialog;
}

test('a remote host that is not signed in offers its terminal, prefilled, and a retry', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page);
  const notice = dialog.getByRole('alert');
  await expect(notice).toContainText("devbox isn't signed in to GitHub.");
  await expect(notice).toContainText('Sign in on devbox, then try again.');
  await expect(notice.getByRole('button')).toHaveText(['Open terminal on devbox to sign in', 'Try again']);
  await expect(dialog.getByText(LOCAL_HTTPS_MESSAGE)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-sign-in-notice.png') });

  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls)).toEqual([
    [REPO_URL, '/tmp/pane-worktrees'],
    [REPO_URL, '/tmp/pane-worktrees'],
  ]);
  await expect(notice).toContainText("devbox isn't signed in to GitHub.");

  await notice.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
  await expect(dialog).toHaveCount(0);
  const inputs = await page.evaluate(() => window.__cloneProbe?.terminalInputs);
  expect(inputs).toEqual([SIGN_IN_COMMAND]);
  expect(inputs?.[0]).not.toMatch(/[\r\n]/);
  await page.screenshot({ path: testInfo.outputPath('remote-terminal-opened.png') });

  // Coming back after signing in finds the same URL and destination.
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByPlaceholder('https://github.com/user/repo')).toHaveValue(REPO_URL);
  await expect(reopened.getByPlaceholder('Select a destination folder...')).toHaveValue('/tmp/pane-worktrees');
  await reopened.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls.at(-1))).toEqual([REPO_URL, '/tmp/pane-worktrees']);
  await page.screenshot({ path: testInfo.outputPath('remote-reopened-try-again.png') });
});

test('this computer keeps the plain sign-in message', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toBeVisible();
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page);
  await expect(dialog.getByText(LOCAL_HTTPS_MESSAGE)).toBeVisible();
  await expect(dialog.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Open terminal/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('local-https-message.png') });
});

test('a sign-in draft stays with its host when the user switches hosts', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page);
  await expect(dialog.getByRole('alert')).toContainText("devbox isn't signed in to GitHub.");
  await dialog.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => window.electronAPI.remoteDaemon.updateClientState({ mode: 'local', activeProfileId: null }));
  await expect(page.getByRole('button', { name: 'Agents run on This computer. Switch host' })).toBeVisible();
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const local = page.getByRole('dialog');
  await expect(local.getByPlaceholder('https://github.com/user/repo')).toHaveValue('');
  await expect(local.getByPlaceholder('Select a destination folder...')).toHaveValue('');
  await expect(local.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  await expect(local.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('switched-host-clean-dialog.png') });
  await local.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__cloneProbe?.cloneCalls.length)).toBe(1);
});
