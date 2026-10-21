import {test,expect,type Page} from '@playwright/test';
// These tests run against a Vite fixture and intercept every backend request.
// No test request can reach an irrigation controller.
test.beforeEach(async({page})=>{
  await page.route('**/*.supabase.co/**',route=>route.abort());
});
type Body={action:string;sequence:number;potNumber?:number;testCandidate?:boolean;destination?:{kind:string;relayAddress?:number;channel?:number;potNumber?:number}};
type Reply=(body:Body)=>Promise<Record<string,unknown>>|Record<string,unknown>;
const ready=(action:string)=>({status:['start','renew','takeover'].includes(action)?'open':'closed',available:true,ready:true});
async function controller(page:Page,reply:Reply=({action})=>ready(action)){
  const actions:string[]=[];
  const bodies:Body[]=[];
  await page.route('**/functions/v1/manual-hold',async route=>{
    const body=route.request().postDataJSON();actions.push(body.action);bodies.push(body);
    await route.fulfill({json:{...await reply(body),serverTime:Date.now()}});
  });
  return Object.assign(actions,{bodies});
}
const harness=`http://127.0.0.1:${process.env.EXACTH2O_HARNESS_PORT || '5178'}/browser-tests/hold-harness.html`;
const stopped='Stopped · the controller reports the valve closed';
const status=(page:Page)=>page.locator('.px-water-status [role="status"]');

test('mouse and keyboard holds water until release, then stop is confirmed',async({page})=>{
  const actions=await controller(page);
  await page.goto(harness);
  const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.waitForTimeout(900);
  await page.mouse.up();await expect(status(page)).toHaveText(stopped);
  expect(actions.filter(x=>x==='start')).toHaveLength(1);
  expect(actions.filter(x=>x==='renew').length).toBeGreaterThanOrEqual(1);
  const afterStop=actions.length;await page.waitForTimeout(900);expect(actions.length).toBe(afterStop);
  await button.focus();await page.keyboard.down('Space');await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.keyboard.up('Space');await expect(status(page)).toHaveText(stopped);
  await expect(page.getByText(/Release to confirmed close: \d+ ms/)).toBeVisible();
});

test('holds past the old 15-second limit, shows the elapsed time, and stops on release',async({page,browserName})=>{
  test.skip(browserName!=='chromium','A 17-second real hold runs in one engine.');
  const actions=await controller(page);
  await page.goto(harness);
  const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.waitForTimeout(17_000);
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await expect(page.locator('.px-hold-sub')).toContainText(/1[6-9]\.\d s|2\d\.\d s/);
  expect(actions).not.toContain('stop');
  await page.mouse.up();await expect(status(page)).toHaveText(stopped);
  expect(actions.filter(x=>x==='renew').length).toBeGreaterThan(20);
});

test('touch: press and hold waters, a second finger changes nothing, lifting the first stops',async({browser})=>{
  const context=await browser.newContext({hasTouch:true,viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.route('**/*.supabase.co/**',route=>route.abort());
  const actions=await controller(page);
  await page.goto(harness);
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
  // The same control throughout; its name changes from "Hold to water" to "Watering".
  const control=page.locator('.px-hold');
  const pointer=(type:string,pointerId:number,isPrimary=true)=>control.dispatchEvent(type,{pointerId,pointerType:'touch',isPrimary,button:0,bubbles:true});
  await pointer('pointerdown',7);
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await pointer('pointerdown',8,false);await pointer('pointerup',8,false);
  await page.waitForTimeout(700);
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  expect(actions).not.toContain('stop');
  await pointer('pointerup',7);
  await expect(status(page)).toHaveText(stopped);
  await context.close();
});

test('release during a delayed start stops it and never shows watering',async({page})=>{
  let finishStart:()=>void=()=>{};
  const actions=await controller(page,async({action})=>{
    if(action==='start')await new Promise<void>(resolve=>{finishStart=resolve;});
    return {status:action==='start'?'open':'closed',available:true,ready:true};
  });
  await page.goto(harness);const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect.poll(()=>actions.includes('start')).toBe(true);
  await page.mouse.up();await expect.poll(()=>actions.includes('stop')).toBe(true);
  const settled=actions.length;finishStart();
  await expect(status(page)).toHaveText(stopped);
  await expect(page.getByRole('button',{name:/Watering/})).toHaveCount(0);
  await page.waitForTimeout(800);expect(actions.slice(settled).filter(x=>x!=='stop')).toEqual([]);
});

test('window blur and a cancelled pointer both stop a held valve',async({page})=>{
  const actions=await controller(page);
  await page.goto(harness);const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect.poll(()=>actions.filter(x=>x==='stop').length).toBe(1);await page.mouse.up();
  await expect(status(page)).toContainText(/Stopped|closed/);
  const control=page.locator('.px-hold');
  // Only the pointer that started the hold can end it: cancel that pointer (its id differs by engine).
  await control.evaluate((node)=>node.addEventListener('pointerdown',(event)=>{(window as unknown as {heldPointer:number}).heldPointer=(event as PointerEvent).pointerId;}));
  await control.hover();await page.mouse.down();await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  const pointerId=await page.evaluate(()=>(window as unknown as {heldPointer:number}).heldPointer);
  await control.dispatchEvent('pointercancel',{pointerId,pointerType:'mouse',isPrimary:true,bubbles:true});await expect.poll(()=>actions.filter(x=>x==='stop').length).toBeGreaterThanOrEqual(2);await page.mouse.up();
});

test('a controller that ends the hold is reported, and the button can be pressed again',async({page})=>{
  let renewals=0;
  await controller(page,({action})=>({status:action==='start'||(action==='renew'&&++renewals<2)?'open':'closed',available:true,ready:true}));
  await page.goto(harness);const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();
  await expect(status(page)).toContainText('The controller ended the hold');
  await page.mouse.up();await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
});

test('another operator holding the controller is shown as busy; taking over is explicit',async({page})=>{
  let taken=false;
  const actions=await controller(page,({action})=>action==='status'&&!taken?{status:'closed',busy:true,activeOwnerLabel:'pan',available:true,ready:true}
    :action==='takeover'?(taken=true,{status:'open'}):ready(action));
  await page.goto(harness);
  await expect(status(page)).toHaveText('In use by pan.');
  const button=page.getByRole('button',{name:/Hold to/});
  await expect(button).toBeDisabled();
  await page.getByText(/Take over: close the other hold first/).click();
  await expect(page.getByRole('button',{name:/Hold to take over/})).toBeEnabled();
  await page.getByRole('button',{name:/Hold to take over/}).hover();await page.mouse.down();
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.mouse.up();
  expect(actions.filter(x=>x==='takeover')).toHaveLength(1);
  expect(actions).not.toContain('start');
});

test('with autocalibration running in this tab, holding asks first and then interrupts the run',async({page})=>{
  await controller(page);
  await page.goto(`${harness}?autocal`);
  await expect(page.getByText(/Autocalibration is running in this tab/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeDisabled();
  await page.getByRole('button',{name:'Stop autocalibration when I hold'}).click();
  const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.hover();await page.mouse.down();
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {interrupted:string[]}).interrupted)).toEqual(['Pot 18']);
  await page.mouse.up();await expect(status(page)).toHaveText(stopped);
});

test('troubleshooting reaches any configured solenoid directly, by its number',async({page})=>{
  const outputs=Array.from({length:100},(_,index)=>({key:`${32+Math.floor(index/48)}:${(index%48)+1}`,relayAddress:32+Math.floor(index/48),channel:(index%48)+1,
    solenoidNumber:index+1,labelStatus:'needs_confirmation',labelSource:'printed',pots:index===73?[]:[index+1],candidatePots:[],pairing:null}));
  const actions=await controller(page,(body)=>body.action==='inventory'?{pots:[],outputs,boards:[32,33,34],canConfirm:false,canTakeover:true,leaseMs:2500,renewMs:500}:ready(body.action));
  await page.goto(`${harness}?manual`);
  await expect(page.getByText('100 configured outputs on 3 boards.',{exact:false})).toBeVisible();
  await page.getByRole('textbox',{name:/Solenoid number/}).fill('74');
  await page.getByRole('button',{name:/^Solenoid 74, board 0x21 channel 26, physical pot unknown/}).click();
  await expect(page.getByRole('heading',{name:'Solenoid 74',exact:true})).toBeVisible();
  await expect(page.getByText('Board 0x21 · channel 26')).toBeVisible();
  await expect(page.getByText(/no recorded route uses this output/)).toBeVisible();
  const button=page.getByRole('button',{name:/Hold to water/});await expect(button).toBeEnabled();
  await button.focus();await page.keyboard.down('Enter');
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.keyboard.up('Enter');
  await expect(status(page)).toHaveText(stopped);
  const start=actions.bodies.find(x=>x.action==='start');
  expect(start?.destination).toEqual({kind:'solenoid',relayAddress:33,channel:26});
  expect(start?.potNumber).toBeUndefined();
});

test('Find pot permits recorded candidate testing without confirming the mapping',async({page})=>{
  const route=(pot:number)=>pot===16?{pot,status:'ready',relayAddress:36,channel:16,source:'field_record_2026-06-15',evidence:'Zone 1 field passes.',pairing:{name:'Zone3-Pot66',sensorKey:'D30GQN2D:P',namedPot:66}}
    :pot===100?{pot,status:'ready',relayAddress:32,channel:43,source:'field_record_2026-06-16',evidence:'Re-piped.',pairing:{name:'Zone4-Pot100',sensorKey:'D30GQN2E:2',namedPot:100}}
    :pot===77?{pot,status:'needs_confirmation',candidate:{relayAddress:32,channel:30},source:'field_record_2026-06-15',evidence:'Not re-tested.'}
    :pot===86?{pot,status:'no_water_line',source:'field_record_2026-06-16',evidence:'Line moved to 96-100.'}
    :{pot,status:'unmapped',reason:'No recorded valve route'};
  const pots=Array.from({length:100},(_,index)=>route(index+1));
  const actions=await controller(page,(body)=>body.action==='inventory'?{pots,outputs:[],boards:[32,36,38],canConfirm:true,canTakeover:true,leaseMs:2500,renewMs:500}:ready(body.action));
  await page.goto(`${harness}?find`);
  const search=page.getByRole('combobox');
  for(const [query,expected,badge] of [['1','Pot 1','No route'],['100','Pot 100','Ready'],['77','Pot 77','Needs check'],['86','Pot 86','No water line']] as const){
    await search.fill(query);const first=page.getByRole('option').first();await expect(first).toContainText(expected);await expect(first).toContainText(badge);
  }
  // Pot 16 is watered by valve 0x24:16, whose sensor pairing carries another pot's name.
  await search.fill('16');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'Pot 16',exact:true})).toBeVisible();
  await expect(page.getByText('0x24 · channel 16')).toBeVisible();
  await expect(page.getByText(/sensor pairing is named Zone3-Pot66/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
  await page.getByRole('button',{name:'← All pots'}).click();
  await search.fill('77');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'Needs a physical check'})).toBeVisible();
  const candidateButton=page.getByRole('button',{name:/Hold to water/});
  await expect(candidateButton).toBeEnabled();
  await candidateButton.focus(); await page.keyboard.down('Space');
  await expect(page.getByRole('button',{name:/Watering/})).toBeVisible();
  await page.keyboard.up('Space');
  await expect(status(page)).toHaveText(stopped);
  expect(actions.bodies.find(x=>x.action==='start')).toMatchObject({potNumber:77,testCandidate:true});
  expect(actions).not.toContain('confirm_route');
  await expect(page.getByRole('combobox',{name:'Channel'})).toHaveValue('30');
  await expect(page.getByRole('button',{name:'Confirm route'})).toBeDisabled();
  await page.getByRole('button',{name:'← All pots'}).click();
  await search.fill('86');await search.press('Enter');
  await expect(page.getByRole('heading',{name:'No water line'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Hold to water/})).toHaveCount(0);
  expect(actions.bodies.filter(x=>['start','renew'].includes(x.action)).every(x=>x.potNumber===77&&x.testCandidate===true)).toBe(true);
});

test('temporary status failure reconnects automatically without starting water',async({page})=>{
  const actions:string[]=[];
  let probes=0;
  await page.route('**/functions/v1/manual-hold',async route=>{
    const body=route.request().postDataJSON();actions.push(body.action);
    if(++probes===1)await route.fulfill({status:503,json:{error:'Controller response unavailable'}});
    else await route.fulfill({json:{status:'closed',ready:true,available:true,serverTime:Date.now()}});
  });
  await page.goto(harness);
  await expect(status(page)).toContainText('Retrying automatically');
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeEnabled();
  expect(actions).toEqual(['status','status']);
});

test('controller fault stays unavailable and is never treated as a connection retry',async({page})=>{
  const actions=await controller(page,()=>({status:'fault',ready:false,available:true}));
  await page.goto(harness);
  await expect(status(page)).toContainText('valve fault');
  await expect(page.getByRole('button',{name:/Hold to water/})).toBeDisabled();
  await page.waitForTimeout(2200);
  expect([...actions]).toEqual(['status']);
});
