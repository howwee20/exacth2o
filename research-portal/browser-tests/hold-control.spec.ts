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

test('Find pot covers pots 1-100 by physical route, and only ready pots can be held',async({page})=>{
  const route=(pot:number)=>pot===16?{pot,status:'ready',relayAddress:36,channel:16,source:'field_record_2026-06-15',evidence:'Zone 1 field passes.',pairing:{name:'Zone3-Pot66',sensorKey:'D30GQN2D:P',namedPot:66}}
    :pot===100?{pot,status:'ready',relayAddress:32,channel:43,source:'field_record_2026-06-16',evidence:'Re-piped.',pairing:{name:'Zone4-Pot100',sensorKey:'D30GQN2E:2',namedPot:100}}
    :pot===77?{pot,status:'needs_confirmation',candidate:{relayAddress:32,channel:30},source:'field_record_2026-06-15',evidence:'Not re-tested.'}
    :pot===86?{pot,status:'no_water_line',source:'field_record_2026-06-16',evidence:'Line moved to 96-100.'}
    :{pot,status:'unmapped',reason:'No recorded valve route'};
  const pots=Array.from({length:100},(_,index)=>route(index+1));
  const actions=await controller(page,({action})=>action==='routes'?{pots,boards:[32,36,38],canConfirm:true}:{status:'closed',available:true,ready:true});
  await page.goto(`${harness}?find`);
  const search=page.getByRole('combobox');
  for(const [query,expected,badge] of [['1','Pot 1','No route'],['100','Pot 100','Ready'],['77','Pot 77','Needs check'],['86','Pot 86','No water line']] as const){
    await search.fill(query);const first=page.getByRole('option').first();await expect(first).toContainText(expected);await expect(first).toContainText(badge);
  }
  // Pot 16 is watered by valve 0x24:16, whose sensor pairing carries another pot's name.
  await search.fill('16');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'Pot 16'})).toBeVisible();
  await expect(page.getByText('0x24 · channel 16')).toBeVisible();
  await expect(page.getByText(/sensor pairing is named Zone3-Pot66/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
  await page.getByRole('button',{name:'← All pots'}).click();
  await search.fill('77');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'Needs a physical check'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Channel'})).toHaveValue('30');
  await expect(page.getByRole('button',{name:'Confirm route'})).toBeDisabled();
  await page.getByRole('button',{name:'← All pots'}).click();
  await search.fill('86');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'No water line'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toHaveCount(0);
  expect(actions.filter(x=>['start','renew'].includes(x))).toEqual([]);
});
