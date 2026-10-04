import { test, expect } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seedEmptyCloudWithLocalGame, readSave } from './support/cloud-fixture';
import { createLibrary, connectLibrary } from './support/gui';
import { createSnapshotForGame } from './support/local-gui';
import { createRunRoot, hostPost } from './support/rgsm-instance';
import { startDualSession } from './support/session';
import { cloudPaths, readJson } from './support/cloud-assertions';

test('first manual upload registers a local game without a preparation button', async ({
  browser,
}, testInfo) => {
  const runRoot = await createRunRoot('local-game-cloud');
  const scene = await seedEmptyCloudWithLocalGame(runRoot);
  const file = join(scene.deviceB.appDataDir, 'GameSaveManager.config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.games[0].name = 'Private game';
  config.games[0].storage_key = 'private-game';
  config.games[0].save_paths[0].paths = {
    [scene.deviceB.id]: scene.deviceB.savePath.replaceAll('\\', '/'),
  };
  await writeFile(file, JSON.stringify(config));
  await mkdir(join(scene.deviceB.archiveRoot, 'private-game'));
  await copyFile(
    join(scene.deviceB.archiveRoot, 'Echo Keep/Backups.json'),
    join(scene.deviceB.archiveRoot, 'private-game/Backups.json')
  );
  const session = await startDualSession(browser, { ...scene, runRoot, label: 'local-game-cloud' });
  let failed = false;
  try {
    await createLibrary(session.pageA);
    await connectLibrary(session.pageB);
    const originalSave = await readSave(scene.deviceB);
    const remoteBefore = await readJson(cloudPaths(scene.cloudRoot).sharedLibrary);
    const snapshot = await createSnapshotForGame(session.hostB, 'Private game', 'Manual upload');
    expect(await readJson(cloudPaths(scene.cloudRoot).sharedLibrary)).toEqual(remoteBefore);
    await session.pageB.goto('/SyncSettings');
    const row = session.pageB.locator('[data-game-id="private-game"]');
    await expect(row).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Prepare cloud backup', exact: true })
    ).toHaveCount(0);
    await row.getByRole('button', { name: 'Upload this game', exact: true }).click();
    await expect
      .poll(async () => {
        const manifest = await readJson(cloudPaths(scene.cloudRoot).manifest);
        return JSON.stringify(manifest).includes(snapshot);
      })
      .toBe(true);
    const profile = await hostPost<{
      games: Array<{ storage_key: string; cloud_sync_enabled: boolean }>;
    }>(session.hostB, '/api/v1/get-local-config');
    expect(
      profile.data.games.find((game) => game.storage_key === 'private-game')?.cloud_sync_enabled
    ).toBe(false);
    expect(await readSave(scene.deviceB)).toBe(originalSave);
    await session.pageB.screenshot({ path: testInfo.outputPath('manual-first-upload.png') });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await session.close(failed);
  }
});
