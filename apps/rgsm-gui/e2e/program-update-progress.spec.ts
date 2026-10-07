import { test, expect } from '@playwright/test';
import { createRunRoot } from './support/rgsm-instance';
import { seedLocalConfig } from './support/local-fixture';
import { startLocalSession } from './support/local-session';

test('update progress displays real sizes and speed, recovers after navigation and failure', async ({
  browser,
}, testInfo) => {
  const runRoot = await createRunRoot('update-progress');
  const device = await seedLocalConfig(runRoot);
  const session = await startLocalSession(browser, { runRoot, device, label: 'update-progress' });
  let stage = 'downloading';
  let failed = false;
  try {
    await session.page.route('**/api/v1/events', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ eventType: 'program-update-progress', payload: { stage, downloadedBytes: 24 * 1024 * 1024, totalBytes: 48 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 } })}\n\n`,
      })
    );
    await session.page.goto('/Settings');
    await expect(session.page.getByRole('progressbar')).toHaveAttribute('value', '50');
    await expect(session.page.getByText('50% · 24.00 MiB / 48.00 MiB · 2.00 MiB/s')).toBeVisible();
    await session.page.screenshot({ path: testInfo.outputPath('update-progress.png') });
    await session.page.goto('/');
    await session.page.goto('/Settings');
    await expect(session.page.getByRole('progressbar')).toHaveAttribute('value', '50');
    stage = 'verifying';
    await expect(session.page.getByText('Download complete. Verifying integrity…')).toBeVisible();
    await expect(session.page.getByRole('progressbar')).toHaveCount(0);
    stage = 'failed';
    await expect(
      session.page.getByText('Update failed. You can retry; the current program is unchanged.')
    ).toBeVisible();
    await expect(
      session.page.getByRole('button', { name: 'Check for updates', exact: true })
    ).toBeEnabled();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await session.close(failed);
  }
});
