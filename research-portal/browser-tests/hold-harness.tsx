// Local browser test only. Never included in the public release.
import {createRoot} from 'react-dom/client';
import {HoldWaterControl} from '../src/HoldWaterControl';
import {FindPotDialog} from '../src/product/FindPotDialog';
import {ManualWaterPanel} from '../src/product/ManualWaterPanel';
import {ManualWaterClient} from '../src/manualWaterApi';
import {controllerOwnership} from '../src/controllerOwnership';
import {supabase} from '../src/supabase';
import '../src/product/product.css';
supabase.auth.getSession = async () => ({data:{session:{access_token:'isolated-test-token'}},error:null}) as never;
const pairing = {id:1,name:'Zone3-Pot18',pot_number:18,zone:3,source_sensor_id:1,source_valve_id:2,sensor_key:'D30GQN2E:R',valve_key:'0x24:18',wtc_percent_limit:35,valve_open_time_ms:4000,measurement_interval_ms:600000};
const host = document.getElementById('root')!;
host.className = 'px-shell';
const root = createRoot(host);
const params = new URLSearchParams(location.search);
if (params.has('autocal')) {
  // A stand-in for an autocalibration run driven by this tab.
  (window as unknown as {interrupted: string[]}).interrupted = [];
  controllerOwnership.claimAutocal({kind:'autocalibration',runId:'hw-test',label:'8 pots',
    interruptForManual:(label)=>(window as unknown as {interrupted: string[]}).interrupted.push(label), stop:()=>{}});
}
if (params.has('find')) {
  root.render(<FindPotDialog open onClose={() => {}} pairings={[pairing]} experiments={[]} routeFor={() => ({view:'experiments'}) as never}
    manualControl={{projectId:'test-project',deviceId:'test-device',controllerName:'Greenhouse controller'}} />);
} else if (params.has('manual')) {
  root.render(<ManualWaterPanel open onClose={() => {}} projectId="test-project" deviceId="test-device" controllerName="Greenhouse controller" />);
} else {
  const client = new ManualWaterClient('test-project','test-device');
  const destination = params.has('solenoid') ? {kind:'solenoid' as const, relayAddress:33, channel:26} : {kind:'pot' as const, potNumber:18};
  root.render(<HoldWaterControl client={client} destination={destination} label={params.has('solenoid') ? 'Solenoid 74' : 'Pot 18'} />);
}
