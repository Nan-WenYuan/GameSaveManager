import { expect, test } from '@playwright/test';
import { seedEmptyCloudWithLocalGame } from './support/cloud-fixture';
import { GAME_NAME } from './support/constants';
import { createLibrary, openGame, snapshotRow } from './support/gui';
import { listSnapshotsFor } from './support/local-gui';
import { startLocalSession } from './support/local-session';
import { createRunRoot } from './support/rgsm-instance';

test('new local backups appear on the current game without requesting a cloud refresh', async ({
  browser,
}) => {
  const runRoot = await createRunRoot('local-backup-refresh');
  const seeded = await seedEmptyCloudWithLocalGame(runRoot);
  const session = await startLocalSession(browser, {
    runRoot,
    device: seeded.deviceA,
    label: 'local-backup-refresh',
  });
  const { page, host } = session;
  let release = () => {};
  let failed = false;
  try {
    await createLibrary(page);
    const initialRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/get-game-snapshots-info'
    );
    await openGame(page);
    await initialRead;
    await page.evaluate(async () => {
      const path = '/src/composables/useCloudLibrary.ts';
      await (await import(path)).refreshCloudLibrary();
    });
    let captured = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/refresh-cloud-archive-library', async (route) => {
      const response = await route.fetch();
      captured = true;
      await gate;
      await route.fulfill({ response });
    });

    for (const description of ['first local backup', 'second local backup']) {
      await page.getByPlaceholder('New backup description').fill(description);
      await page.getByRole('button', { name: 'Create local backup' }).click();
      await expect
        .poll(async () =>
          (await listSnapshotsFor(host, GAME_NAME)).find((item) => item.describe === description)
        )
        .toBeTruthy();
      const snapshot = (await listSnapshotsFor(host, GAME_NAME)).find(
        (item) => item.describe === description
      )!;
      // No navigation, no cloud response, and no backend-only assertion of visibility.
      await expect(snapshotRow(page, snapshot.date)).toBeVisible({ timeout: 5_000 });
    }
    await page.evaluate(async () => {
      const path = '/src/composables/useCloudLibrary.ts';
      (await import(path)).clearCloudLibrary();
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    expect(captured).toBe(false);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    for (const snapshot of await listSnapshotsFor(host, GAME_NAME)) {
      await expect(snapshotRow(page, snapshot.date)).toBeVisible();
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await session.close(failed);
  }
});
