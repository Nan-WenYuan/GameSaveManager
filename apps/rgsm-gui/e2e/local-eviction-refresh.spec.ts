import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cloudArchivePath, cloudPaths, localArchivePath } from './support/cloud-assertions';
import { readFile } from 'node:fs/promises';
import { seedEmptyCloudWithLocalGame, readSave } from './support/cloud-fixture';
import { GAME_NAME } from './support/constants';
import { createLibrary, openGame, snapshotRow } from './support/gui';
import { getLocalGame, listSnapshotsFor } from './support/local-gui';
import { startLocalSession } from './support/local-session';
import { createRunRoot, hostPost } from './support/rgsm-instance';

test('removing local copies refreshes unpublished and uploaded backups without navigation', async ({
  browser,
}) => {
  const runRoot = await createRunRoot('local-eviction-refresh');
  const seeded = await seedEmptyCloudWithLocalGame(runRoot);
  const session = await startLocalSession(browser, {
    runRoot,
    device: seeded.deviceA,
    label: 'local-eviction-refresh',
  });
  const { page, host } = session;
  let failed = false;
  try {
    await createLibrary(page);
    await openGame(page);
    const save = await readSave(seeded.deviceA);
    for (const uploaded of [false, true]) {
      const description = uploaded ? 'uploaded copy' : 'unpublished copy';
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
      const catalog = await hostPost<{
        games: Array<{ snapshots: Array<{ snapshot_id: string; local_evidence: string }> }>;
      }>(host, '/api/v1/refresh-cloud-archive-library');
      expect(catalog.ok, catalog.raw).toBe(true);
      expect(catalog.data.games.flatMap((game) => game.snapshots)).toContainEqual(
        expect.objectContaining({ snapshot_id: snapshot.date, local_evidence: 'present' })
      );
      expect(await readFile(cloudPaths(seeded.cloudRoot).manifest, 'utf8')).not.toContain(
        snapshot.date
      );
      await page.evaluate(async () => {
        const path = '/src/composables/useCloudLibrary.ts';
        await (await import(path)).refreshCloudLibrary(true);
      });
      if (uploaded) {
        const game = await getLocalGame(host, GAME_NAME);
        const result = await hostPost(host, '/api/v1/upload-cloud-archive', {
          gameId: game.storage_key,
          snapshotId: snapshot.date,
        });
        expect(result.ok, result.raw).toBe(true);
        await page.evaluate(async () => {
          const path = '/src/composables/useCloudLibrary.ts';
          await (await import(path)).refreshCloudLibrary(true);
        });
      }
      const row = snapshotRow(page, snapshot.date);
      await expect(row).toBeVisible();
      const cloudBeforeRemoval = await readFile(cloudPaths(seeded.cloudRoot).manifest, 'utf8');
      await row.getByRole('button', { name: 'Remove local copy', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Remove local copy', exact: true })
        .click();
      await expect
        .poll(() => existsSync(localArchivePath(seeded.deviceA.appDataDir, snapshot.date)))
        .toBe(false);
      if (uploaded) {
        expect(existsSync(cloudArchivePath(seeded.cloudRoot, snapshot.date))).toBe(true);
        await expect(row).toContainText('Cloud only');
        await expect(
          row.getByRole('button', { name: 'Remove local copy', exact: true })
        ).toBeDisabled();
        await expect(row.getByRole('button', { name: 'Pull', exact: true })).toBeEnabled();
      } else {
        await expect(row).toHaveCount(0);
      }
      expect(await readSave(seeded.deviceA)).toBe(save);
      expect(await readFile(cloudPaths(seeded.cloudRoot).manifest, 'utf8')).toBe(
        cloudBeforeRemoval
      );
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await session.close(failed);
  }
});
