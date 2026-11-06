import {test, expect} from '@playwright/test';

test('clicking a trace keeps its small readout without opening the pot inspector', async ({page}) => {
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.goto('/demo?experiment=experiment-1');
  const chart = page.getByRole('group', {name:/^Soil moisture \(VWC %\) for/}).first();
  await chart.press('Home');
  await chart.press('Shift+ArrowRight');
  const readout = chart.locator('.chart-tooltip.is-locked');
  await expect(readout).toBeVisible();
  const dot = await chart.locator('.chart-lock-dot').boundingBox();
  expect(dot).not.toBeNull();
  await page.mouse.click(dot!.x + dot!.width / 2, dot!.y + dot!.height / 2);
  await expect(page).toHaveURL(/\/demo\?experiment=experiment-1$/);
  await expect(page.getByRole('complementary', {name:'Pot inspector', exact:true})).toHaveCount(0);
  await expect(readout).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(readout).toBeVisible();
  await chart.press('Escape');
  await expect(chart.locator('.chart-tooltip')).toHaveCount(0);
});
