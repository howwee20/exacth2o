import { expect, test } from '@playwright/test';

// Exercise the production wrapper and normal phone entry points with an isolated project.
test('Rhee phone shows two studies, lists case-sensitive probes and groups an unpaired range', async ({ page }) => {
  const project='22222222-2222-4222-8222-222222222222', device='3100e37ee3205651fe3dd86dafd4dc0c';
  const user={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'field@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
  const exp=Math.floor(Date.now()/1000)+3600;
  const token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({sub:user.id,role:'authenticated',aud:'authenticated',exp})).toString('base64url')}.test`;
  await page.addInitScript(({token,user,exp})=>localStorage.setItem('sb-zmhdclcjrkntrpynozvo-auth-token',JSON.stringify({access_token:token,refresh_token:'test',token_type:'bearer',expires_in:3600,expires_at:exp,user})),{token,user,exp});
  const curve='matts greenhouse pots',now=new Date().toISOString();
  const sensors=['A','a'].map((address,i)=>({id:i+1,boardSerialId:'Board1',address}));
  const config={project_id:project,device_id:device,pairings:[],sensors,calibrations:[{name:curve,polynomialCoefficientsCommaDelimited:'100.68,-0.1289,0.00004'}],groups:[],observed_at:now,updated_at:now,config_hash:'preview'};
  const studies=['Pan','Greenhouse study'].map((name,i)=>({id:`study-${i}`,slug:`study-${i}`,name,mode:'controlled',status:'active',watering_state:'off',pairing_names:[],assignments:[]}));
  const writes:string[]=[]; let saved:Record<string,unknown>|null=null;
  await page.route('https://*.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url()),endpoint=url.pathname.split('/').pop();let data:unknown=[];
    switch(endpoint){
      case 'user':data=user;break;
      case 'portal_access':data=[{project_id:project,role:'researcher',access_scope:'project',email:user.email,created_at:now}];break;
      case 'projects':data=[{id:project,name:'Matt Greenhouse'}];break;
      case 'devices':data=[{id:device}];break;
      case 'device_config_state':data=url.searchParams.has('device_id')?config:[config];break;
      case 'portal_experiment_catalog':data=studies;break;
      case 'rhee-discovery':{
        const body=req.postDataJSON();
        if(body.action==='start'){
          writes.push(body.action);expect(body.version).toBe(2);expect(body.setup.curve).toBe(curve);
          expect(body.setup.pots.map((p:{pot:number})=>p.pot)).toEqual(Array.from({length:12},(_,i)=>i+1));
          expect(body.setup.pots.map((p:{group:string})=>p.group)).toEqual([...Array(6).fill('Control'),...Array(6).fill('Drought')]);
          saved={id:'saved-run',owner:true,status:'running',phase:'baseline',finished:0,matches:[],missing:[],updatedAt:now,workerVersion:2,setup:body.setup,message:'Reading unused probes before the first pulse.'};
        } else expect(body.action).toBe('status');data={run:saved};break;}
      case 'device_runtime_state':case 'latest_device_state':case 'commissioning_sessions':data=null;break;
      default:if(req.method()==='POST' && /control-command|manual-hold/.test(url.pathname))throw Error('Unexpected controller write');
    }
    await route.fulfill({json:data,headers:{'content-range':'*/0'}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto('/portal');
  const machine=page.getByRole('group',{name:'Rhee Lab',exact:true});
  await expect(machine.getByRole('link',{name:'Pan',exact:true})).toHaveAttribute('href',/experiment=study-0/);
  await expect(machine.getByRole('link',{name:'Greenhouse study'})).toHaveAttribute('href',/experiment=study-1/);
  const branch=machine.getByRole('link',{name:'Pan',exact:true});
  expect(await branch.evaluate(el=>getComputedStyle(el,'::before').borderTopStyle)).toBe('dashed');
  expect(await branch.evaluate(el=>getComputedStyle(el,'::after').borderLeftStyle)).toBe('dashed');
  await page.screenshot({path:test.info().outputPath('rhee-branches-phone.png'),fullPage:true});
  await machine.getByText('Sensor inventory',{exact:true}).click();await machine.getByText('Board1 · 2 sensors').click();
  await expect(machine.getByRole('rowheader',{name:'A',exact:true})).toBeVisible();await expect(machine.getByRole('rowheader',{name:'a',exact:true})).toBeVisible();
  await machine.getByRole('link',{name:'New experiment on Rhee Lab'}).click();
  await page.getByLabel('Experiment name',{exact:true}).fill('Twelve pots');await page.getByRole('button',{name:'Calibration',exact:true}).click();
  await page.getByLabel('Pot numbers or range').fill('1–12');await page.getByRole('button',{name:'Add to group'}).click();
  await page.getByRole('radio',{name:'Drought',exact:true}).check();await page.getByLabel('Pot numbers or range').fill('7-12');await page.getByRole('button',{name:'Add to group'}).click();
  await expect(page.getByText('6 pots',{exact:true})).toHaveCount(2);
  await page.getByRole('button',{name:'Review Autopair'}).click();expect(writes).toEqual([]);await page.getByRole('button',{name:'Start Autopair'}).click();
  await expect(page.getByText('Reading unused probes before the first pulse.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('Reading unused probes before the first pulse.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.goto('/portal');await expect(page.getByRole('link',{name:/Autopair setup.*Twelve pots/})).toBeVisible();expect(writes).toEqual(['start']);
});
