import { test, expect, type Page } from '@playwright/test';

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

test('product showcase plays with the current poster and captions', async ({page}) => {
  await page.goto('/#software-tour');
  const video=page.locator('#softwareTourVideo');
  await expect(video).toHaveAttribute('poster','/media/software-tour-poster-cursor-20261013.jpg');
  await page.getByRole('button',{name:'Watch the tour 0:24',exact:true}).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.1);
  expect(await video.evaluate((v: HTMLVideoElement) => ({duration:v.duration,width:v.videoWidth,height:v.videoHeight,error:v.error?.message ?? null}))).toEqual({duration:24,width:1920,height:1200,error:null});
  await expect(page.locator('track')).toHaveAttribute('src','/media/software-tour-cursor-20261013.vtt');
});

test('mobile Applications embed loads the current release and closes', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/applications');
  const frameElement=page.locator('iframe.portal-demo-frame');
  await expect(frameElement).toHaveAttribute('src',/index\.html\?v=[a-f0-9]+/);
  await frameElement.scrollIntoViewIfNeeded();
  const frame=page.frameLocator('iframe.portal-demo-frame');
  await frame.getByRole('link',{name:'Crop comparison 24 pots',exact:true}).click();
  await expect(page.getByRole('button',{name:'Close experiment',exact:true})).toBeVisible();
  await frame.getByRole('combobox',{name:'Comparison view'}).selectOption({label:'Crop water use'});
  await expect(frame.locator('.px-trace-heading')).toContainText('3 of 24');
  await page.getByRole('button',{name:'Close experiment',exact:true}).click();
  await expect(page.getByRole('button',{name:'Close experiment',exact:true})).toBeHidden();
});

// WebKitGTK in CI delivers mouse.wheel events without moving the document.
// Supply that movement explicitly for its motion integration checks. Chromium
// and Firefox use native wheel scrolling; macOS Safari is also checked natively.
async function footerWheel(page:Page, browserName:string, deltaY:number) {
  if(browserName!=='webkit') {await page.mouse.wheel(0,deltaY);return;}
  await page.evaluate(delta => {
    window.dispatchEvent(new WheelEvent('wheel',{deltaY:delta}));
    window.scrollBy({top:delta,behavior:'instant'});
  },deltaY);
}

test('footer water ignores stationary overscroll', async ({page,browserName}) => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/');
  const level=page.locator('.brand-water-level'), empty='M600 250H1040V260H600Z';
  await expect(page.locator('#brand-water-lines rect')).toHaveAttribute('fill','#91e4d2');
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight-innerHeight-scrollY)).toBeLessThanOrEqual(3);
  await expect(level).toHaveAttribute('d',empty);
  // Real browser wheel input at rest cannot lift the water.
  await page.mouse.move(400,400);await footerWheel(page,browserName,800);await page.waitForTimeout(150);
  await expect(level).toHaveAttribute('d',empty);
});

test('footer water stays quiet on a gentle arrival', async ({page,browserName}) => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/');
  const level=page.locator('.brand-water-level'), empty='M600 250H1040V260H600Z';
  await page.evaluate(() => window.scrollTo({top:document.documentElement.scrollHeight-innerHeight-24,behavior:'instant'}));
  await page.waitForTimeout(200);await page.mouse.move(900,500);
  for(let i=0;i<8;i++){await footerWheel(page,browserName,3);await page.waitForTimeout(70);}
  await expect(level).toHaveAttribute('d',empty);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight-innerHeight-scrollY)).toBeLessThanOrEqual(3);
});

test('footer water rises on a fast arrival and drains once', async ({page,browserName}, info) => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/');
  const level=page.locator('.brand-water-level'), empty='M600 250H1040V260H600Z';
  await page.evaluate(() => window.scrollTo({top:document.documentElement.scrollHeight-innerHeight-450,behavior:'instant'}));
  await expect.poll(() => page.evaluate(() => Math.abs(document.documentElement.scrollHeight-innerHeight-scrollY-450))).toBeLessThanOrEqual(1);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const events: {type:string,at:number,y:number,remaining:number}[]=[];
    Object.assign(window,{footerMotionProbe:events});
    for(const type of ['wheel','scroll'])window.addEventListener(type,() => {
      if(events.length<120)events.push({type,at:performance.now(),y:scrollY,remaining:document.documentElement.scrollHeight-innerHeight-scrollY});
    },{passive:true});
  });
  await page.mouse.move(900,500);
  await footerWheel(page,browserName,900);
  try {
    await expect.poll(() => level.getAttribute('d'),{intervals:[20,40,60]}).not.toBe(empty);
  } finally {
    const events=await page.evaluate(() => (window as unknown as {footerMotionProbe:unknown[]}).footerMotionProbe);
    await info.attach('footer-scroll-timing',{body:JSON.stringify(events),contentType:'application/json'});
  }
  await page.waitForTimeout(180);
  await info.attach('footer-fast-arrival',{body:await page.screenshot(),contentType:'image/png'});
  await expect(level).toHaveAttribute('d',empty,{timeout:2500});
  await footerWheel(page,browserName,900);await page.waitForTimeout(150);
  await expect(level).toHaveAttribute('d',empty);
});
