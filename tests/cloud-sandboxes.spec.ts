import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { CloudSandboxAction, CloudSandboxProgressStep, CloudSandboxView } from '../shared/types/cloudSandboxes';
import type { RemotePaneConnectionProfile } from '../shared/types/remoteDaemon';

type CloudMockControls = {
  reportCloudStep(name: string, step: CloudSandboxProgressStep): void;
  finishCloudCreate(name: string, failure?: string): void;
  failNextCloudAction(action: CloudSandboxAction, message: string): void;
  setCloudSandbox(id: string, updates: Partial<CloudSandboxView>): void;
  getCloudCalls(): Array<{ action: CloudSandboxAction; id: string }>;
  getCloudCredentialUpdateKeys(): string[][];
};

const ALL_CREDENTIALS = { boat: true, tailscale: true, claude: true };
const HOUR_MS = 60 * 60 * 1000;

function cloudProfile(name: string): RemotePaneConnectionProfile {
  return {
    id: `cloud-${name}`,
    label: name,
    baseUrl: `https://rp-${name}.tail1234.ts.net`,
    token: 'synthetic-cloud-token',
    transport: 'http+sse',
    cloud: { provider: 'boat', sandboxId: `sbx-${name}`, sessionId: name, nodeId: `node-${name}`, hostname: `rp-${name}`, version: 1 },
  };
}

function cloudSandbox(name: string, overrides: Partial<CloudSandboxView> = {}): CloudSandboxView {
  return {
    id: `rp-${name}`,
    label: name,
    hostname: `rp-${name}`,
    profileId: `cloud-${name}`,
    state: 'running',
    size: 'default',
    ...overrides,
  };
}

async function cloudMock<Result>(page: Page, run: (controls: CloudMockControls) => Result): Promise<Result> {
  return page.evaluate(`(${run.toString()})(window.__paneTestElectronMock)`);
}

async function openRemoteAccess(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' })).toBeVisible();
}

test('cloud credentials are saved once and only shown as set or not set', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: { boat: false, tailscale: false, claude: false }, sandboxes: [] } });
  await openRemoteAccess(page);

  const status = page.getByRole('definition');
  await expect(status).toHaveText(['Not set', 'Account default', 'Not set', 'Not set']);
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toBeDisabled();

  await page.getByLabel('boat API key').fill('synthetic-boat-key-value');
  await page.getByLabel('boat wallet').fill('test');
  await page.getByLabel('Tailscale OAuth client ID').fill('synthetic-ts-client-id');
  await expect(page.getByRole('button', { name: 'Save Credentials' })).toBeDisabled();
  await expect(page.getByText('Enter both the client ID and secret')).toBeVisible();
  await page.getByLabel('Tailscale OAuth client secret').fill('synthetic-ts-client-secret');
  await page.getByLabel('Claude token').fill('synthetic-claude-token');
  await page.getByRole('button', { name: 'Save Credentials' }).click();

  await expect(status).toHaveText(['Set', 'test', 'Set', 'Set']);
  await expect(page.getByLabel('boat API key')).toHaveCount(0);
  expect(await cloudMock(page, (mock) => mock.getCloudCredentialUpdateKeys())).toEqual([['boatApiKey', 'boatOrg', 'claudeToken', 'tailscale']]);
  const html = await page.content();
  for (const value of ['synthetic-boat-key-value', 'synthetic-ts-client-secret', 'synthetic-claude-token', 'synthetic-ts-client-id']) {
    expect(html).not.toContain(value);
  }
  await page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-credentials-saved.png') });

  // Changing one credential sends only that one.
  await page.getByRole('button', { name: 'Change Credentials' }).click();
  await expect(page.getByLabel('boat API key')).toHaveValue('');
  await page.getByLabel('Claude token').fill('synthetic-claude-token-2');
  await page.getByRole('button', { name: 'Save Credentials' }).click();
  expect((await cloudMock(page, (mock) => mock.getCloudCredentialUpdateKeys())).at(-1)).toEqual(['claudeToken']);
});

test('adding a cloud sandbox shows live progress, a failure with Retry, then the running host', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [] } });
  await openRemoteAccess(page);

  await page.getByLabel('Name', { exact: true }).fill('Bad Name');
  await expect(page.getByText('Use lowercase letters, digits and dashes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('alpha');
  await page.getByRole('radio', { name: 'Small' }).click();
  await page.getByRole('button', { name: 'Add Cloud Sandbox' }).click();

  const row = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  await expect(row.getByText('Creating', { exact: true })).toBeVisible();
  await cloudMock(page, (mock) => {
    mock.reportCloudStep('alpha', { step: 'sandbox', state: 'done', message: 'Created boat sandbox rp-alpha' });
    mock.reportCloudStep('alpha', { step: 'tailnet', state: 'done', message: 'Joined your tailnet as rp-alpha' });
    mock.reportCloudStep('alpha', { step: 'install', state: 'start', message: 'Installing Pane' });
  });
  const progress = row.getByRole('status', { name: 'Progress for alpha' });
  await expect(progress.getByRole('listitem')).toHaveText(['Created boat sandbox rp-alpha', 'Joined your tailnet as rp-alpha', 'Installing Pane']);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-create-progress.png') });

  await cloudMock(page, (mock) => mock.finishCloudCreate('alpha', 'install: the Pane package did not install'));
  await expect(row.getByText('Error', { exact: true })).toBeVisible();
  await expect(row.getByRole('alert')).toHaveText('install: the Pane package did not install');
  await row.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-create-failed.png') });

  await row.getByRole('button', { name: 'Retry alpha' }).click();
  await expect(row.getByText('Creating', { exact: true })).toBeVisible();
  await expect(row.getByRole('alert')).toHaveCount(0);
  await cloudMock(page, (mock) => mock.finishCloudCreate('alpha'));

  await expect(row.getByText('Running', { exact: true })).toBeVisible();
  await expect(row.getByText('rp-alpha · small · running for 1m')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Stop alpha' })).toBeVisible();
  expect((await cloudMock(page, (mock) => mock.getCloudCalls())).map((call) => call.action)).toEqual(['create', 'create']);

  // The new host is in the switcher like any other saved host.
  await page.getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
  await expect(page.getByRole('menuitemradio', { name: /alpha/ })).toContainText('https://rp-alpha.tail1234.ts.net');
});

test('cloud rows stop, start, update Pane and remove after confirmation', async ({ page }, testInfo) => {
  const startedAt = new Date(Date.now() - 5 * HOUR_MS - 60_000).toISOString();
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [
        cloudSandbox('alpha', { startedAt, daemonVersion: '2.4.140', updateAvailable: true }),
        cloudSandbox('beta', { state: 'stopped', size: 'large' }),
      ],
      profiles: [cloudProfile('alpha'), cloudProfile('beta')],
    },
  });
  await openRemoteAccess(page);

  const alpha = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  const beta = page.getByRole('listitem', { name: 'Cloud sandbox beta' });
  await expect(alpha.getByText('rp-alpha · default · running for 5h · Pane 2.4.140 (differs from this app)')).toBeVisible();
  await expect(alpha.getByRole('button')).toHaveText(['Update Pane', 'Stop', 'Remove']);
  await expect(beta.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(beta.getByRole('button')).toHaveText(['Start', 'Remove']);
  await alpha.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-rows.png') });

  await alpha.getByRole('button', { name: 'Update Pane alpha' }).click();
  await expect(alpha.getByText('Updating', { exact: true })).toBeVisible();
  await expect(alpha.getByText('Running', { exact: true })).toBeVisible();
  await expect(alpha.getByRole('button')).toHaveText(['Stop', 'Remove']);

  await alpha.getByRole('button', { name: 'Stop alpha' }).click();
  await expect(alpha.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(alpha.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(alpha.getByText(/running for/)).toHaveCount(0);

  await cloudMock(page, (mock) => mock.failNextCloudAction('start', 'boat.dev did not resume the sandbox in time'));
  await alpha.getByRole('button', { name: 'Start alpha' }).click();
  await expect(alpha.getByRole('alert')).toHaveText('boat.dev did not resume the sandbox in time');
  await alpha.getByRole('button', { name: 'Dismiss alpha' }).click();
  await alpha.getByRole('button', { name: 'Start alpha' }).click();
  await expect(alpha.getByText('Running', { exact: true })).toBeVisible();

  await beta.getByRole('button', { name: 'Remove beta' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove beta?' });
  await expect(confirm).toContainText('destroys the sandbox and its tailnet device');
  await page.screenshot({ path: testInfo.outputPath('cloud-remove-confirm.png') });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(beta).toBeVisible();
  await beta.getByRole('button', { name: 'Remove beta' }).click();
  await page.getByRole('dialog', { name: 'Remove beta?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(beta).toHaveCount(0);

  expect((await cloudMock(page, (mock) => mock.getCloudCalls())).map((call) => `${call.action} ${call.id}`)).toEqual([
    'update rp-alpha',
    'stop rp-alpha',
    'start rp-alpha',
    'start rp-alpha',
    'remove rp-beta',
  ]);
  const savedProfiles = await page.evaluate(() => window.electronAPI.remoteDaemon.getConfig().then((response) => response.data?.client.profiles.map((profile) => profile.id)));
  expect(savedProfiles).toEqual(['cloud-alpha']);
});

test('the host switcher starts a stopped sandbox, then connects to it', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [cloudSandbox('beta', { state: 'stopped' })],
      profiles: [cloudProfile('beta')],
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();

  const beta = page.getByRole('menuitemradio', { name: /beta/ });
  await expect(beta).toContainText('Stopped · Select to start');
  await page.screenshot({ path: testInfo.outputPath('switcher-stopped-sandbox.png') });
  await beta.click();

  await expect(page.getByRole('button', { name: 'Agents run on beta. Switch host' })).toBeVisible();
  expect(await cloudMock(page, (mock) => mock.getCloudCalls())).toEqual([{ action: 'start', id: 'rp-beta' }]);
  await page.getByRole('button', { name: 'Agents run on beta. Switch host' }).click();
  await expect(page.getByRole('menuitemradio', { name: /beta/ })).toContainText('Connected · https://rp-beta.tail1234.ts.net');
});

test('a sandbox boat is still saving shows Stopping in the row and the switcher, then Stopped with Start', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [cloudSandbox('beta')],
      profiles: [cloudProfile('beta')],
    },
  });
  await openRemoteAccess(page);
  const row = page.getByRole('listitem', { name: 'Cloud sandbox beta' });
  await expect(row.getByText('Running', { exact: true })).toBeVisible();

  // What main pushes after a Stop that outlived its wait while boat still archives.
  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopping', pending: 'stopping', progress: 'Saving the sandbox…' }));
  await expect(row.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(row.getByRole('status')).toHaveText('Saving the sandbox…');
  await expect(row.getByRole('button', { name: /^(Stop|Start) beta$/ })).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-row-stopping.png') });

  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopping', pending: undefined, progress: undefined }));
  await expect(row.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: /^(Stop|Start) beta$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
  const switcherRow = page.getByRole('menuitemradio', { name: /beta/ });
  await expect(switcherRow).toContainText('Stopping cloud sandbox…');
  await expect(switcherRow).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('switcher-stopping.png') });

  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopped' }));
  await expect(switcherRow).toContainText('Stopped · Select to start');
  await expect(switcherRow).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(row.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Start beta' })).toBeVisible();
});

test('without the cloud library the section explains itself and remote hosts are unchanged', async ({ page }) => {
  await installElectronApiMock(page);
  await openRemoteAccess(page);

  await expect(page.getByText('Cloud sandboxes are not available in this build of Pane.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toHaveCount(0);
  await expect(page.getByText('Using local runtime')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set Up Host' })).toBeVisible();
});
