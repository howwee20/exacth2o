import {test, expect} from '@playwright/test';

// The bundled demo supplies all data locally. Navigation tests must never run valves.
test('Autocalibrate is a page and survives refresh, Back, and old settings links', async ({page}) => {
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.goto('/demo?view=autocalibrate');
  await expect(page).toHaveURL(/\/demo\?view=autocalibrate$/);
  await expect(page.getByRole('heading', {name:'Autocalibrate', level:1})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.ac-map-pot')).toHaveCount(100);
  await page.reload();
  await expect(page.getByRole('heading', {name:'Autocalibrate', level:1})).toBeVisible();
  await page.getByRole('link', {name:'← Experiments', exact:true}).click();
  await expect(page.getByRole('heading', {name:'Autocalibrate', level:1})).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', {name:'Autocalibrate', level:1})).toBeVisible();
  await page.goto('/demo?view=controller&settings=autocalibrate');
  await expect(page).toHaveURL(/\/demo\?view=autocalibrate$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', {name:'Autocalibrate', level:1})).toBeVisible();
});
