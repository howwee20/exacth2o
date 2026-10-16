import {describe,it,expect} from 'vitest';
import {targetDraft,commandOutcome,targetGroups,targetLabel} from './directExperimentModel';
import type {PairingRow} from '../types';
import type {PortalExperiment} from '../experimentRegistry';
const pairings:PairingRow[]=[65,66,67].map((n,i)=>({id:n,name:`Pot${n}`,pot_number:n,zone:3,source_sensor_id:n,sensor_key:`board:${i}`,source_valve_id:n,valve_key:`0x20:${i}`,wtc_percent_limit:10+i,valve_open_time_ms:2000+i*1000,measurement_interval_ms:600000}));
const experiment:PortalExperiment={id:'trial',name:'Trial',shortDescription:'',mode:'controlled',status:'active',groupNames:[],pairingNames:pairings.map(p=>p.name),assignments:pairings.map(p=>({pairing_name:p.name,pot_number:p.pot_number,zone:3,crop:p.pot_number===66?'Maize':'Sorghum',treatment:null,block:null,substrate:null,target_vwc_percent:35,measurement_interval_minutes:10}))};
describe('direct target changes',()=>{
 it('changes only the explicit scope and preserves live settings for all other pots',()=>{const draft=targetDraft(experiment,pairings,['Pot66'],15);expect(draft.assignments.map(a=>a.target_vwc_percent)).toEqual([10,15,12]);expect(draft.assignments.map(a=>a.valve_open_seconds)).toEqual([2,3,4]);expect(draft.assignments.map(a=>a.measurement_interval_minutes)).toEqual([10,10,10]);expect(experiment.assignments?.[0].target_vwc_percent).toBe(35);});
 it('rejects foreign pots, empty selections and invalid values',()=>{expect(()=>targetDraft(experiment,pairings,['foreign'],15)).toThrow();expect(()=>targetDraft(experiment,pairings,[],15)).toThrow();for(const n of [NaN,Infinity,-1,81,10.5])expect(()=>targetDraft(experiment,pairings,['Pot66'],n)).toThrow();});
 it('does not silently enable watering',()=>{expect(()=>targetDraft(experiment,pairings.map(p=>p.name==='Pot66'?{...p,valve_open_time_ms:0}:p),['Pot66'],15)).toThrow('disabled');});
 it('requires every command acknowledgement before reporting applied',()=>{expect(commandOutcome(['a','b'],[{id:'a',status:'succeeded'}])).toBe('pending');expect(commandOutcome(['a','b'],[{id:'a',status:'succeeded'},{id:'b',status:'failed'}])).toBe('failed');expect(commandOutcome(['a','b'],[{id:'a',status:'succeeded'},{id:'b',status:'succeeded'}])).toBe('applied');expect(commandOutcome([],[])).toBe('pending');});
});

 it('labels mixed-crop treatment targets and keeps their exact pot membership',()=>{
 const controls=new Set([65,66,69,70,73,74]);
 const ps=Array.from({length:12},(_,i)=>({...pairings[0],name:`Pot${65+i}`,pot_number:65+i,wtc_percent_limit:controls.has(65+i)?30:10}));
 const ex={...experiment,pairingNames:ps.map(p=>p.name),assignments:ps.map(p=>({...experiment.assignments![0],pairing_name:p.name,pot_number:p.pot_number,crop:p.pot_number%2?'Sorghum':'Maize',treatment:controls.has(p.pot_number)?'Control':'Drought'}))};
 const groups=targetGroups(ex,ps);
 expect(groups.map(g=>targetLabel(g.value,g,true))).toEqual(['Control 30%','Drought 10%']);
 expect(groups[0].names).toEqual(['Pot65','Pot66','Pot69','Pot70','Pot73','Pot74']);
 expect(groups[1].names).toEqual(['Pot67','Pot68','Pot71','Pot72','Pot75','Pot76']);
 });
