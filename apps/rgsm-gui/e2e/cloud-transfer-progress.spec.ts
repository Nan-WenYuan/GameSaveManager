import { expect, test, type Page } from '@playwright/test';
import { seedEmptyCloudWithLocalGame } from './support/cloud-fixture';
import { createLibrary, openGame, snapshotRow } from './support/gui';
import { startLocalSession } from './support/local-session';
import { createRunRoot } from './support/rgsm-instance';
import { listSnapshotsFor } from './support/local-gui';
import { GAME_NAME } from './support/constants';

async function holdRequest(page: Page, endpoint: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled!: () => void;
  const finished = new Promise<void>((resolve) => {
    handled = resolve;
  });
  await page.route(`**/api/v1/${endpoint}`, async (route) => {
    await gate;
    await route.continue();
    handled();
  });
  return async () => {
    release();
    await finished;
    await page.unroute(`**/api/v1/${endpoint}`);
  };
}

test('cloud transfers show progress during slow requests and clear it after success or failure', async ({
  browser,
}) => {
  const runRoot = await createRunRoot('cloud-transfer-progress');
  const seeded = await seedEmptyCloudWithLocalGame(runRoot);
  const session = await startLocalSession(browser, {
    runRoot,
    device: seeded.deviceA,
    label: 'cloud-transfer-progress',
  });
  const { page, host } = session;
  let failed = false;
  try {
    await createLibrary(page);
    await openGame(page);
    await page.getByPlaceholder('New backup description').fill('progress sample');
    await page.getByRole('button', { name: 'Create local backup' }).click();
    await expect.poll(async () => (await listSnapshotsFor(host, GAME_NAME)).length).toBe(1);
    const snapshot = (await listSnapshotsFor(host, GAME_NAME))[0];
    const releaseArchive = await holdRequest(page, 'upload-cloud-archive');
    await snapshotRow(page, snapshot.date)
      .getByRole('button', { name: 'Upload', exact: true })
      .click();
    const archiveDialog = page.getByRole('dialog', { name: 'Upload', exact: true });
    await expect(archiveDialog).toBeVisible();
    await expect(archiveDialog.getByRole('progressbar')).toBeVisible();
    await expect(archiveDialog).toContainText(GAME_NAME);
    await page.keyboard.press('Escape');
    await expect(archiveDialog).toBeVisible();
    await expect(archiveDialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'e2e-results/cloud-transfer-progress.png' });
    await releaseArchive();
    await expect(archiveDialog).not.toBeVisible();
    await expect(snapshotRow(page, snapshot.date)).toContainText('Local and cloud');
    await page.getByPlaceholder('New backup description').fill('second progress sample');
    await page.getByRole('button', { name: 'Create local backup' }).click();
    await expect.poll(async () => (await listSnapshotsFor(host, GAME_NAME)).length).toBe(2);
    await page.getByRole('button', { name: 'Cloud backup', exact: true }).first().click();
    const releases: Array<() => void> = [];
    await page.route('**/api/v1/upload-cloud-archive', async (route) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Upload this game', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Upload', exact: true }).click();
    const batchDialog = page.getByRole('dialog', { name: 'Upload', exact: true });
    await expect(batchDialog).toContainText('Completed 0 of 2 backups');
    await expect.poll(() => releases.length).toBe(1);
    releases[0]();
    await expect(batchDialog).toContainText('Completed 1 of 2 backups');
    await expect.poll(() => releases.length).toBe(2);
    await page.screenshot({ path: 'e2e-results/cloud-transfer-batch-progress.png' });
    releases[1]();
    await expect(batchDialog).not.toBeVisible();
    await page.unroute('**/api/v1/upload-cloud-archive');
    const releaseConfig = await holdRequest(page, 'upload-game-management-config');
    await page.getByRole('button', { name: 'Upload configuration', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm overwrite' }).click();
    const configDialog = page.getByRole('dialog', { name: 'Upload configuration', exact: true });
    await expect(configDialog.getByRole('progressbar')).toBeVisible();
    await releaseConfig();
    await expect(configDialog).not.toBeVisible();
    await page.route('**/api/v1/pull-game-management-config', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Simulated cloud failure' }),
      });
    });
    await page.getByRole('button', { name: 'Pull configuration', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm overwrite' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Pull configuration', exact: true })
    ).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Upload configuration', exact: true })
    ).toBeEnabled();
    await expect(page.getByText('Configuration transfer failed', { exact: true })).toBeVisible();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await session.close(failed);
  }
});
