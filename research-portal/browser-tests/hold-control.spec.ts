import {test,expect,type Page} from '@playwright/test';
// These tests run against a Vite fixture and intercept every backend request.
// No test request can reach an irrigation controller.
test.beforeEach(async({page})=>{
  await page.route('**/*.supabase.co/**',route=>route.abort());
});
type Reply=(body:{action:string;sequence:number;potNumber:number})=>Promise<Record<string,unknown>>|Record<string,unknown>;
async function controller(page:Page,reply:Reply=({action})=>({status:['start','renew'].includes(action)?'open':'closed',available:true,ready:true})){
  const actions:string[]=[];
  await page.route('**/functions/v1/manual-hold',async route=>{
    const body=route.request().postDataJSON();actions.push(body.action);
    await route.fulfill({json:{...await reply(body),serverTime:Date.now()}});
  });
  return actions;
}
const harness='http://127.0.0.1:5178/browser-tests/hold-harness.html';

test('mouse and keyboard holds water until release, then stop is confirmed',async({page})=>{
  const actions=await controller(page);
  await page.goto(harness);
  const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.waitForTimeout(900);
  await page.mouse.up();await expect(page.getByRole('status')).toHaveText('Stopped · controller confirmed');
  expect(actions.filter(x=>x==='start')).toHaveLength(1);
  expect(actions.filter(x=>x==='renew').length).toBeGreaterThanOrEqual(2);
  const afterStop=actions.length;await page.waitForTimeout(900);expect(actions.length).toBe(afterStop);
  await button.focus();await page.keyboard.down('Space');await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.keyboard.up('Space');await expect(page.getByRole('status')).toHaveText('Stopped · controller confirmed');
});

test('release during a delayed start stops it and never shows watering',async({page})=>{
  let finishStart:()=>void=()=>{};
  const actions=await controller(page,async({action})=>{
    if(action==='start')await new Promise<void>(resolve=>{finishStart=resolve;});
    return {status:action==='start'?'open':'closed',available:true,ready:true};
  });
  await page.goto(harness);const button=page.getByRole('button');await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect.poll(()=>actions.includes('start')).toBe(true);
  await page.mouse.up();await expect.poll(()=>actions.includes('stop')).toBe(true);
  const settled=actions.length;finishStart();
  await expect(page.getByRole('status')).toHaveText('Stopped · controller confirmed');
  await expect(page.getByRole('button',{name:/Watering/})).toHaveCount(0);
  await page.waitForTimeout(800);expect(actions.slice(settled).filter(x=>x!=='stop')).toEqual([]);
});

test('window blur and a cancelled touch both stop a held valve',async({page})=>{
  const actions=await controller(page);
  await page.goto(harness);const button=page.getByRole('button');await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect.poll(()=>actions.filter(x=>x==='stop').length).toBe(1);await page.mouse.up();
  await button.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await button.dispatchEvent('pointercancel');await expect.poll(()=>actions.filter(x=>x==='stop').length).toBe(2);await page.mouse.up();
});

test('a controller that ends the hold is reported, and the button can be pressed again',async({page})=>{
  let renewals=0;
  await controller(page,({action})=>({status:action==='start'||(action==='renew'&&++renewals<2)?'open':'closed',available:true,ready:true}));
  await page.goto(harness);const button=page.getByRole('button');await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();
  await expect(page.getByRole('status')).toContainText('Hold ended by the controller');
  await page.mouse.up();await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
});

test('Find pot lists every pot 1-100 and only waters pots with a confirmed route',async({page})=>{
  const pots=Array.from({length:100},(_,index)=>index+1===18
    ?{pot:18,status:'ready',kind:'pairing',relayAddress:36,channel:18,pairingName:'Zone3-Pot18'}
    :{pot:index+1,status:'unmapped',reason:'No confirmed valve route'});
  const actions=await controller(page,({action})=>action==='routes'?{pots,boards:[32,36,38],canConfirm:true}:{status:'closed',available:true,ready:true});
  await page.goto(`${harness}?find`);
  const search=page.getByRole('combobox');
  for(const [query,expected] of [['1','Pot 1'],['100','Pot 100'],['37','Pot 37']] as const){
    await search.fill(query);await expect(page.getByRole('option').first()).toContainText(expected);
  }
  await expect(page.getByRole('option').first()).toContainText('No route');
  await search.press('Enter');
  await expect(page.getByRole('heading',{name:'Pot 37'})).toBeVisible();
  await expect(page.getByText('No confirmed valve route')).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toHaveCount(0);
  const confirm=page.getByRole('button',{name:'Confirm route'});await expect(confirm).toBeDisabled();
  await expect(page.getByRole('combobox',{name:'Channel'}).locator('option',{hasText:'18 · pot 18'})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Relay board'}).selectOption('36');
  await expect(page.getByRole('combobox',{name:'Channel'}).locator('option',{hasText:'18 · pot 18'})).toHaveAttribute('disabled','');
  await page.getByRole('button',{name:'← All pots'}).click();
  await search.fill('18');await search.press('Enter');
  await expect(page.getByText('0x24 · channel 18')).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
  expect(actions.filter(x=>['start','renew'].includes(x))).toEqual([]);
});
