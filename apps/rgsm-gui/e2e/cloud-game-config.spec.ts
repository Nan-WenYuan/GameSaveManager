import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seedEmptyCloudWithLocalGame, readSave } from './support/cloud-fixture';
import { createLibrary } from './support/gui';
import { startLocalSession } from './support/local-session';
import { createRunRoot, hostPost } from './support/rgsm-instance';

test('configuration sync is confirmed, sanitized, backed up and preserves local data', async ({
  browser,
}) => {
  const runRoot = await createRunRoot('cloud-game-config');
  const seeded = await seedEmptyCloudWithLocalGame(runRoot);
  const session = await startLocalSession(browser, {
    runRoot,
    device: seeded.deviceA,
    label: 'cloud-game-config',
  });
  const { page, host } = session;
  let failed = false;
  try {
    await createLibrary(page);
    await page.getByRole('button', { name: 'Cloud backup', exact: true }).first().click();
    const current = await hostPost<{
      games: Array<{ name: string }>;
      backup_path: string;
      settings: unknown;
    }>(host, '/api/v1/get-local-config');
    const save = await readSave(seeded.deviceA);
    const cloudPath = join(seeded.cloudRoot, 'v2/game-management-config.json');
    const backupPath = join(
      seeded.deviceA.appDataDir,
      'GameSaveManager.config.before-cloud-pull.json'
    );
    const unconfirmed = await hostPost(host, '/api/v1/upload-game-management-config', {
      confirmed: false,
    });
    expect(unconfirmed.ok).toBe(false);
    expect(existsSync(cloudPath)).toBe(false);
    await page.getByRole('button', { name: 'Upload configuration', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm overwrite' }).click();
    await expect.poll(() => existsSync(cloudPath)).toBe(true);
    const portable = JSON.parse(await readFile(cloudPath, 'utf8'));
    expect(Object.keys(portable).sort()).toEqual(['games', 'schema_version']);
    expect(portable.games[0].save_paths[0].source.paths).toEqual({
      local: seeded.deviceA.savePath.replaceAll('\\', '/'),
    });
    expect(await readFile(cloudPath, 'utf8')).not.toContain('cloud_settings');
    portable.games[0].name = 'Restored game configuration';
    portable.games[0].save_paths[0].enabled = false;
    await writeFile(cloudPath, JSON.stringify(portable));
    await page.getByRole('button', { name: 'Pull configuration', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /cancel/i })
      .click();
    expect(existsSync(backupPath)).toBe(false);
    const cancelled = await hostPost<{ games: Array<{ name: string }> }>(
      host,
      '/api/v1/get-local-config'
    );
    expect(cancelled.data.games[0].name).toBe(current.data.games[0].name);
    await page.getByRole('button', { name: 'Pull configuration', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm overwrite' }).click();
    await expect.poll(() => existsSync(backupPath)).toBe(true);
    await expect(
      page.getByText('Restored game configuration', { exact: true }).first()
    ).toBeVisible();
    const pulled = await hostPost<typeof current.data>(host, '/api/v1/get-local-config');
    expect(pulled.data.games[0].name).toBe('Restored game configuration');
    expect(pulled.data.backup_path).toBe(current.data.backup_path);
    expect(pulled.data.settings).toEqual(current.data.settings);
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(current.data);
    expect(await readSave(seeded.deviceA)).toBe(save);
    portable.games[0].storage_key = '../invalid';
    await writeFile(cloudPath, JSON.stringify(portable));
    const invalid = await hostPost(host, '/api/v1/pull-game-management-config', {
      confirmed: true,
    });
    expect(invalid.ok).toBe(false);
    const afterInvalid = await hostPost<typeof current.data>(host, '/api/v1/get-local-config');
    expect(afterInvalid.data).toEqual(pulled.data);
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(current.data);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await session.close(failed);
  }
});
