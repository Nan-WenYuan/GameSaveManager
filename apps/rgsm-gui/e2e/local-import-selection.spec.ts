import { test, expect } from '@playwright/test';
import { seedLocalConfig } from './support/local-fixture';
import { startLocalSession } from './support/local-session';
import { createRunRoot } from './support/rgsm-instance';

test('import selection matches checkboxes and does not accumulate across dialog sessions', async ({
  browser,
}) => {
  const runRoot = await createRunRoot('import-selection');
  const device = await seedLocalConfig(runRoot, { games: [] });
  const session = await startLocalSession(browser, { runRoot, device, label: 'import-selection' });
  try {
    const { page } = session;
    const dialog = page.getByRole('dialog', { name: 'Import Games (Auto-detect Save Locations)' });
    await page.getByRole('button', { name: 'Add game' }).first().click();
    const open = async () => {
      await page.getByRole('button', { name: 'Detect local games' }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Show only locally installed games' }).uncheck();
      const search = dialog.getByRole('textbox', { name: 'Search games...' });
      await expect(search).toBeEnabled({ timeout: 120_000 });
      await search.fill('Stardew Valley');
    };
    await open();
    const checkbox = dialog.getByRole('checkbox', { name: 'Stardew Valley', exact: true });
    await expect(dialog.getByRole('button', { name: /Import 0 selected game/ })).toBeDisabled();
    await checkbox.check();
    await expect(dialog.getByRole('button', { name: /Import 1 selected game/ })).toBeEnabled();
    await checkbox.uncheck();
    await expect(dialog.getByRole('button', { name: /Import 0 selected game/ })).toBeDisabled();
    await checkbox.check();
    await dialog.getByRole('button', { name: /^cancel$/i }).click();
    await open();
    await expect(dialog.getByRole('button', { name: /Import 0 selected game/ })).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
  } finally {
    await session.close();
  }
});
