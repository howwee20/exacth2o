// Reuse the demo's coherent sensor histories and matching irrigation events.
// Keep the Applications page's separate calibration tile and its sample readings.
import {fixture as demo} from '../demo-preview/fixtures';
import {fixture as original} from './fixtures';
const calibration=original.experiments.find(e=>e.id==='calibration')!;
const calibrationPairings=original.data.pairings.filter(p=>p.group_name==='calibration');
const calibrationNames=new Set(calibrationPairings.map(p=>p.name));
const pairings=[...demo.data.pairings,...calibrationPairings];
const readings=[...demo.data.readings,...original.data.readings.filter(r=>calibrationNames.has(r.pairing_name))].sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
export const fixture={...demo,experiments:[...demo.experiments,calibration],data:{...demo.data,pairings,readings,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1)},health:{...demo.health,sensors_expected:pairings.length,sensors_current:pairings.length}};
