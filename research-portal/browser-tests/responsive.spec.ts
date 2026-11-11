import { test, expect, type Page } from '@playwright/test';

async function openSavedViews(page: Page) {
  const toggle = page.getByRole('button', {name:'Pots',exact:true});
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByText('Saved views', {exact:true}).click();
}

test.beforeEach(async ({page}) => { await page.clock.setFixedTime(new Date('2026-10-13T20:00:00Z')); });
const sizes = [{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:1366,height:768},{width:1920,height:1080},{width:3440,height:1440}];
for (const size of sizes) test(`page fit ${size.width}`, async ({page}, info) => {
  await page.setViewportSize(size);
  for (const route of ['/', '/applications','/about','/support','/quote','/privacy','/terms','/data-access','/portal','/demo','/demo?experiment=experiment-2','/demo?experiment=experiment-2&tab=record','/demo?view=bench','/demo?view=trends']) {
    await page.goto(route);
    await expect(page.locator(route === '/portal' ? 'h2' : 'h1').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const exportButton = page.locator('.px-exp-head').getByRole('button',{name:'Export',exact:true});
    if (route==='/demo?experiment=experiment-2') {
      await openSavedViews(page);
      await expect(page.getByRole('combobox',{name:'Saved view'})).toBeVisible();
      await expect(page.getByText('Toggle a pot to compare. Open its details with the arrow.')).toHaveCount(0);
      await exportButton.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await page.getByRole('dialog').evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
      await page.keyboard.press('Escape');
    }
    if (route==='/portal') {
      expect(await page.locator('h2').first().evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(65);
    }
  }
  await page.goto('/demo?experiment=experiment-2');
  await openSavedViews(page);
  await expect(page.getByRole('combobox',{name:'Saved view'})).toBeVisible();
  await page.evaluate(() => document.documentElement.style.fontSize='200%');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await info.attach(`text-zoom-${size.width}`, {body:await page.screenshot(),contentType:'image/png'});
});
for (const size of [sizes[1], sizes[3], sizes[5]]) test(`visual baseline ${size.width}`, async ({page}) => {
  await page.setViewportSize(size);
  for (const [name,route] of [['home','/'],['traces','/demo?experiment=experiment-2'],['sign-in','/portal']]) {
    await page.goto(route);
    await expect(page.locator(name==='sign-in' ? 'h2' : 'h1').first()).toBeVisible();
    if(name==='traces') await expect(page.locator('.px-pots-panel')).toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${name}-${size.width}.png`, {animations:'disabled',maxDiffPixelRatio:0.015});
  }
});
test('home shows the equipment and brings the trace graph into the next section', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');
  await expect(page.locator('.cinema-slide.is-active img')).toHaveAttribute('alt', /^Overhead view of research pots/);
  await expect(page.locator('main > section').nth(1)).toHaveId('one-pot');
  await expect(page.locator('#homepage-trace-chart')).toBeVisible();
  expect((await page.locator('.cinema-hero').boundingBox())!.height).toBeLessThan(700);
  expect((await page.locator('#homepage-trace-chart').boundingBox())!.y).toBeLessThan(1100);
  await expect(page.getByRole('link',{name:'View the traces',exact:true})).toHaveAttribute('href','#one-pot');
});

test('deferred data and saved comparisons', async ({page}) => {
  const loaded: string[]=[]; page.on('request',request => loaded.push(request.url()));
  await page.goto('/demo');
  await expect(page.getByRole('heading',{name:'Experiments',exact:true})).toBeVisible();
  expect(loaded.some(url => /\/App-[^/]+\.js/.test(url))).toBe(false);
  await page.getByRole('link',{name:'Recovery after drought 24 pots',exact:true}).click();
  await openSavedViews(page);
  await expect(page.getByRole('combobox',{name:'Saved view'})).toBeVisible();
  expect(loaded.some(url => /\/App-[^/]+\.js/.test(url))).toBe(true);
  await page.getByRole('combobox',{name:'Saved view'}).selectOption({label:'Early vs delayed recovery'});
  await expect(page.locator('.px-trace-heading')).toContainText('12 of 24');
  await page.getByRole('button',{name:'Save view',exact:true}).click();
  await page.getByRole('textbox',{name:'View name'}).fill('Recovery review');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.reload();
  await openSavedViews(page);
  await page.getByRole('combobox',{name:'Saved view'}).selectOption({label:'Recovery review'});
  await expect(page.locator('.px-trace-heading')).toContainText('12 of 24');
  await page.getByRole('button',{name:'Remove saved view'}).click();
  await page.locator('.control-panel').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0,450));
  await expect(page.getByLabel('Current experiment', {exact:true})).toBeVisible();
  await page.getByLabel('Current experiment',{exact:true}).getByRole('button',{name:'Export'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/demo?experiment=experiment-1');
  await expect(page.getByText('Experiment details',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'Experiment sections'})).toHaveCount(0);
});

test('mobile Applications embed loads the current release and returns home inline', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(() => {
    window.addEventListener('message', event => {
      if (event.data?.type === 'exacth2o-demo' && event.data?.name === 'demo_ready') {
        const root = document.documentElement;
        root.dataset.demoReadyCount = String(Number(root.dataset.demoReadyCount ?? 0) + 1);
      }
    });
  });
  await page.goto('/applications');
  const frameElement=page.locator('iframe.portal-demo-frame');
  await expect(frameElement).toHaveAttribute('src',/index\.html\?v=[a-f0-9]+/);
  await frameElement.scrollIntoViewIfNeeded();
  const frame=page.frameLocator('iframe.portal-demo-frame');
  await expect(frame.getByRole('heading',{name:'Drought response',exact:true})).toBeVisible();
  await expect(frame.getByLabel('Pot traces',{exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready-count','1');
  await expect(frame.getByRole('button',{name:'Pots',exact:true})).toHaveAttribute('aria-expanded','false');
  await frame.getByRole('link',{name:'← Home',exact:true}).click();
  await frame.getByRole('link',{name:'Crop comparison 24 pots',exact:true}).click();
  await expect(frame.getByRole('heading',{name:'Crop comparison',exact:true})).toBeVisible();
  const potsToggle = frame.getByRole('button',{name:'Pots',exact:true});
  if (await potsToggle.isVisible()) await potsToggle.click();
  await frame.getByText('Saved views',{exact:true}).click();
  await frame.getByRole('combobox',{name:'Saved view'}).selectOption({label:'Crop water use'});
  await expect(potsToggle).toContainText('3 shown');
  await frame.getByRole('link',{name:'← Home',exact:true}).click();
  await expect(frame.getByRole('link',{name:'Crop comparison 24 pots',exact:true})).toBeVisible();
});

test('footer water fills on arrival, drains once, and replays after leaving view', async ({page}) => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/');
  const footer = page.locator('.brand-finale');
  const level = page.locator('.brand-water-level');
  const empty = 'M600 250H1040V260H600Z';

  await footer.scrollIntoViewIfNeeded();
  await expect.poll(() => level.getAttribute('d')).not.toBe(empty);
  await expect(level).toHaveAttribute('d', empty, {timeout:2500});
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(150);
  await expect(level).toHaveAttribute('d', empty);

  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  await expect(footer).not.toBeInViewport();
  await footer.scrollIntoViewIfNeeded();
  await expect.poll(() => level.getAttribute('d')).not.toBe(empty);
});

test('footer water stops when it leaves view', async ({page}) => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/');
  const level = page.locator('.brand-water-level');
  await page.locator('.brand-finale').scrollIntoViewIfNeeded();
  await expect.poll(() => level.getAttribute('d')).not.toBe('M600 250H1040V260H600Z');
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  await expect(level).toHaveAttribute('d', 'M600 250H1040V260H600Z');
});

test('footer water respects reduced motion, including a change during animation', async ({page}) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  const footer = page.locator('.brand-finale');
  const level = page.locator('.brand-water-level');
  const empty = 'M600 250H1040V260H600Z';
  await footer.scrollIntoViewIfNeeded();
  await expect(level).toHaveAttribute('d', empty);

  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  await expect(footer).not.toBeInViewport();
  await page.emulateMedia({reducedMotion:'no-preference'});
  await footer.scrollIntoViewIfNeeded();
  await expect.poll(() => level.getAttribute('d')).not.toBe(empty);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(level).toHaveAttribute('d', empty);
});
