import {test,expect} from '@playwright/test';
const harness='http://127.0.0.1:5178/browser-tests/direct-harness.html';
test.beforeEach(async({page})=>{await page.route('**/*.supabase.co/**',route=>route.abort());});
test('drag and keyboard preview only; Cancel never sends a command',async({page})=>{
 const requests:string[]=[];page.on('request',r=>{if(r.url().includes('/functions/'))requests.push(r.url());});
 await page.goto(harness);await page.getByRole('combobox',{name:'Target scope'}).selectOption('crop:Maize');
 const handle=page.getByRole('slider',{name:'Maize · 1 pots target'});await handle.focus();await handle.press('ArrowUp');await expect(handle).toHaveAttribute('aria-valuenow','11');
 const box=await handle.boundingBox();if(!box)throw Error('Missing handle');await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2-12);await page.mouse.up();await expect(handle).toHaveAttribute('aria-valuenow','14');
 await expect(page.getByRole('button',{name:'Apply',exact:true})).toBeVisible();expect(requests).toEqual([]);await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(handle).toHaveAttribute('aria-valuenow','10');expect(requests).toEqual([]);
});
test('Apply uses explicit scope and waits for every controller acknowledgement',async({page})=>{
 const bodies:Record<string,any>[]=[];let polls=0;
 await page.route('**/functions/v1/experiment-builder',async route=>{const body=route.request().postDataJSON();bodies.push(body);await route.fulfill({json:body.action==='edit_preflight'?{draft:body.draft,plan:{change_count:1,changes:[{pairing_names:['Pot66']}]},config_hash:'verified',inventory_updated_at:'2026-10-16T18:00:00Z'}:{experiment_slug:'trial',status:'activating',command_ids:['stop','update','resume']}});});
 await page.route('**/rest/v1/project_control_commands?*',async route=>{polls++;await route.fulfill({json:['stop','update','resume'].map(id=>({id,status:polls<2&&id==='resume'?'queued':'succeeded'}))});});
 await page.goto(harness);await page.getByRole('combobox',{name:'Target scope'}).selectOption('crop:Maize');await page.getByRole('spinbutton',{name:'Target percent'}).fill('15');await page.getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByText('Waiting for controller…')).toBeVisible();await expect(page.getByText('Applied · controller confirmed')).toBeVisible();
 expect(bodies.map(b=>b.action)).toEqual(['edit_preflight','edit_apply']);expect(bodies[1].draft.assignments.map((a:any)=>a.target_vwc_percent)).toEqual([10,15,10]);expect(bodies[1].expected_revision_id).toBe('revision-1');expect(bodies[1].reviewed_config_hash).toBe('verified');expect(polls).toBeGreaterThanOrEqual(2);
});
test('a preflight that widens scope is rejected before Apply reaches hardware',async({page})=>{
 const actions:string[]=[];await page.route('**/functions/v1/experiment-builder',async route=>{const body=route.request().postDataJSON();actions.push(body.action);await route.fulfill({json:{draft:body.draft,plan:{change_count:2,changes:[{pairing_names:['Pot65','Pot66']}]},config_hash:'changed',inventory_updated_at:'2026-10-16T18:00:00Z'}});});
 await page.goto(harness);await page.getByRole('combobox',{name:'Target scope'}).selectOption('crop:Maize');await page.getByRole('spinbutton',{name:'Target percent'}).fill('15');await page.getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Other pots changed');expect(actions).toEqual(['edit_preflight']);
});
