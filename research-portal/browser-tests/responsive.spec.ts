import { test, expect } from '@playwright/test';

test.beforeEach(async ({page}) => { await page.clock.setFixedTime(new Date('2026-10-13T20:00:00Z')); });
const sizes = [{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:1366,height:768},{width:1920,height:1080},{width:3440,height:1440}];
for (const size of sizes) test(`page fit ${size.width}`, async ({page}, info) => {
  await page.setViewportSize(size);
  for (const route of ['/', '/applications','/about','/support','/quote','/privacy','/terms','/data-access','/portal','/demo','/demo?experiment=experiment-2','/demo?experiment=experiment-2&tab=record','/demo?view=bench','/demo?view=trends']) {
    await page.goto(route);
    await expect(page.locator(route === '/portal' ? 'h2' : 'h1').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const close = page.getByRole('button',{name:'Export',exact:true});
    if (route==='/demo?experiment=experiment-2') {
      await expect(page.getByRole('combobox',{name:'Comparison view'})).toBeVisible();
      await expect(page.getByText('Toggle a pot to compare. Open its details with the arrow.')).toHaveCount(0);
      await close.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await page.getByRole('dialog').evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
      await page.keyboard.press('Escape');
    }
    if (route==='/portal') {
      expect(await page.locator('h2').first().evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(65);
    }
  }
  await page.goto('/demo?experiment=experiment-2');
  await expect(page.getByRole('combobox',{name:'Comparison view'})).toBeVisible();
  await page.evaluate(() => document.documentElement.style.fontSize='200%');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await info.attach(`text-zoom-${size.width}`, {body:await page.screenshot(),contentType:'image/png'});
});
for (const size of [sizes[1], sizes[3], sizes[5]]) test(`visual baseline ${size.width}`, async ({page}) => {
  await page.setViewportSize(size);
  for (const [name,route] of [['home','/'],['traces','/demo?experiment=experiment-2'],['sign-in','/portal']]) {
    await page.goto(route);
    await expect(page.locator(name==='sign-in' ? 'h2' : 'h1').first()).toBeVisible();
    if(name==='traces') await expect(page.getByRole('combobox',{name:'Comparison view'})).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${name}-${size.width}.png`, {animations:'disabled',maxDiffPixelRatio:0.015});
  }
});
test('photo pause, deferred data and saved comparisons', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Play photos',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Play photos',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause photos',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Pause photos',exact:true}).click();
  const active = await page.locator('.cinema-photo.is-active').getAttribute('aria-label');
  await page.waitForTimeout(7200);
  await expect(page.locator('.cinema-photo.is-active')).toHaveAttribute('aria-label',active!);
  const loaded: string[]=[]; page.on('request',request => loaded.push(request.url()));
  await page.goto('/demo');
  await expect(page.getByRole('heading',{name:'Experiments',exact:true})).toBeVisible();
  expect(loaded.some(url => /\/App-[^/]+\.js/.test(url))).toBe(false);
  await page.getByRole('link',{name:'Recovery after drought 24 pots',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Comparison view'})).toBeVisible();
  expect(loaded.some(url => /\/App-[^/]+\.js/.test(url))).toBe(true);
  await page.getByRole('combobox',{name:'Comparison view'}).selectOption({label:'Early vs delayed recovery'});
  await expect(page.locator('.px-trace-heading')).toContainText('12 of 24');
  await page.getByRole('button',{name:'Save view',exact:true}).click();
  await page.getByRole('textbox',{name:'View name'}).fill('Recovery review');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.reload();
  await page.getByRole('combobox',{name:'Comparison view'}).selectOption({label:'Recovery review'});
  await expect(page.locator('.px-trace-heading')).toContainText('12 of 24');
  await page.getByRole('button',{name:'Remove saved view'}).click();
  await page.locator('.control-panel').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0,450));
  await expect(page.getByLabel('Current experiment', {exact:true})).toBeVisible();
  await page.getByLabel('Current experiment',{exact:true}).getByRole('button',{name:'Export'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/demo?experiment=experiment-1');
  await page.getByText('Experiment details',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'Data source',exact:true})).toBeVisible();
  await expect(page.locator('.px-source-note')).toContainText('measurement values and intervals are unchanged');
});
