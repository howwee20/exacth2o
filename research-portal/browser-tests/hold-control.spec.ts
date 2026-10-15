import {test,expect} from '@playwright/test';
// This test runs against a Vite fixture, and intercepts every backend request.
// No test request can reach an irrigation controller.
test.beforeEach(async({page})=>{
 await page.route('**/*.supabase.co/**',route=>route.abort());
});
test('mouse release and keyboard release send stop, never restart',async({page})=>{
 const actions:string[]=[];
 await page.route('**/functions/v1/manual-hold',async route=>{
  const body=route.request().postDataJSON();actions.push(body.action);
  await route.fulfill({json:{available:true,status:['start','renew'].includes(body.action)?'open':'closed',startedAt:Date.now()}});
 });
 await page.goto('http://127.0.0.1:5178/browser-tests/hold-harness.html');
 const button=page.getByRole('button',{name:'Hold to water'});await expect(button).toBeEnabled();
 await button.hover();await page.mouse.down();await expect(page.getByRole('button')).toContainText('Watering');
 await page.mouse.up();await expect(page.getByRole('status')).toContainText('Stopped · controller confirmed');
 expect(actions.filter(x=>x==='start')).toHaveLength(1);expect(actions).toContain('stop');
 await button.focus();await page.keyboard.down('Space');await expect(page.getByRole('button')).toContainText('Watering');await page.keyboard.up('Space');await expect(page.getByRole('status')).toContainText('Stopped · controller confirmed');
});
test('release during delayed start sends cancellation and cannot display watering',async({page})=>{
 const actions:string[]=[];let finishStart:()=>void=()=>{};
 await page.route('**/functions/v1/manual-hold',async route=>{
  const {action}=route.request().postDataJSON();actions.push(action);
  if(action==='start')await new Promise<void>(resolve=>{finishStart=resolve;});
  await route.fulfill({json:{available:true,status:action==='start'?'open':'closed',startedAt:Date.now()}});
 });
 await page.goto('http://127.0.0.1:5178/browser-tests/hold-harness.html');const button=page.getByRole('button');await expect(button).toBeEnabled();
 await button.hover();await page.mouse.down();await expect.poll(()=>actions.includes('start')).toBe(true);
 await page.mouse.up();await expect.poll(()=>actions.includes('stop')).toBe(true);finishStart();
 await expect(page.getByRole('status')).toContainText('Stopped');expect(actions).not.toContain('renew');
});
test('window blur stops a held valve',async({page})=>{
 const actions:string[]=[];
 await page.route('**/functions/v1/manual-hold',async route=>{const {action}=route.request().postDataJSON();actions.push(action);await route.fulfill({json:{available:true,status:action==='start'?'open':'closed',startedAt:Date.now()}});});
 await page.goto('http://127.0.0.1:5178/browser-tests/hold-harness.html');const button=page.getByRole('button');await expect(button).toBeEnabled();await button.hover();await page.mouse.down();await expect(button).toContainText('Watering');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect.poll(()=>actions.includes('stop')).toBe(true);await page.mouse.up();
});
