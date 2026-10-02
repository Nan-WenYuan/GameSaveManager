import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { createRunRoot, hostPost } from './support/rgsm-instance';
import { seedLocalConfig, writeSaveText } from './support/local-fixture';
import { startLocalSession } from './support/local-session';
import { DEVICE_A_ID } from './support/constants';
import type { Game } from '../src/api/generated/types.gen';

test('renaming updates immediately while device status checks are pending', async ({
  browser,
}, testInfo) => {
  const runRoot = await createRunRoot('local-edit-refresh');
  const device = await seedLocalConfig(runRoot);
  await writeSaveText(device.savePath, 'local save');
  const session = await startLocalSession(browser, {
    runRoot,
    device,
    label: 'local-edit-refresh',
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { page, host } = session;
    const config = await hostPost<{ games: Game[] }>(host, '/api/v1/get-local-config');
    const game = config.data.games[0];
    const launchPath = join(runRoot, 'Games', 'Example.exe');
    const updated = await hostPost(host, '/api/v1/update-game', {
      storageKey: game.storage_key,
      game: {
        name: game.name,
        save_paths: game.save_paths,
        game_paths: { [DEVICE_A_ID]: launchPath },
      },
    });
    expect(updated.ok, updated.raw).toBe(true);
    await page.reload();
    await page.getByText(game.name, { exact: true }).first().click();
    await expect(page.getByText(`Game launch path: ${launchPath}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View managed files' }).click();
    const drawer = page.getByRole('dialog');
    await drawer
      .getByRole('textbox', { name: 'Game name', exact: true })
      .fill('Renamed immediately');
    await page.route('**/api/v1/get-current-device-game-statuses', async (route) => {
      await pending;
      await route.continue().catch(() => {});
    });
    const [response] = await Promise.all([
      page.waitForResponse((result) => result.url().endsWith('/api/v1/update-game')),
      drawer.getByRole('button', { name: 'save', exact: true }).click(),
    ]);
    expect(response.ok()).toBe(true);
    await expect(drawer).not.toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole('heading', { name: 'Renamed immediately', exact: true })
    ).toBeVisible({ timeout: 3000 });
    await expect(page.getByText(`Game launch path: ${launchPath}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('editor-result.png') });
  } finally {
    release();
    await session.close();
  }
});
