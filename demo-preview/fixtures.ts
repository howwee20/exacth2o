// Demo account fixtures: Experiment 1 runs with controller-managed watering, Experiment 2 is a
// completed run, Experiment 3 is the sensing-only observation view. Sample data only.
import {fixture as base,experiments as baseExperiments,walkerSnapshot,mixer,sampleProfile} from '../applications-preview/fixtures';
export {walkerSnapshot,mixer,sampleProfile};
const startedAt=new Date(Date.now()-3*86400000).toISOString();
const one=baseExperiments.find(e=>e.id==='experiment-1')!,two=baseExperiments.find(e=>e.id==='experiment-2')!;
export const experiments=[
 {...one,mode:'controlled',status:'active',wateringState:'controller_managed',shortDescription:'Drought study · controller-managed watering',startedAt},
 {...two},
];
const names=new Set(experiments.flatMap(e=>e.pairingNames));
const pairings=base.data.pairings.filter(p=>names.has(p.name));
const readings=base.data.readings.filter(r=>names.has(r.pairing_name));
export const fixture={...base,experiments,valveEvents:base.valveEvents.filter((v:any)=>names.has(v.pairing_name)),data:{...base.data,pairings,readings,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1)}};
