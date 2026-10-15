// Local browser test only. Never included in the public release.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HoldWaterControl} from '../src/HoldWaterControl';
import {FindPotDialog} from '../src/product/FindPotDialog';
import {ManualWaterClient} from '../src/manualWaterApi';
import {supabase} from '../src/supabase';
import '../src/product/product.css';
supabase.auth.getSession = async () => ({data:{session:{access_token:'isolated-test-token'}},error:null}) as never;
const pairing = {id:1,name:'Zone3-Pot18',pot_number:18,zone:3,source_sensor_id:1,source_valve_id:2,sensor_key:'D30GQN2E:R',valve_key:'0x24:18',wtc_percent_limit:35,valve_open_time_ms:4000,measurement_interval_ms:600000};
const host = document.getElementById('root')!;
host.className = 'px-shell';
const root = createRoot(host);
if (new URLSearchParams(location.search).has('find')) {
  root.render(<FindPotDialog open onClose={() => {}} pairings={[pairing]} experiments={[]} routeFor={() => ({view:'experiments'}) as never}
    manualControl={{projectId:'test-project',deviceId:'test-device',controllerName:'Greenhouse controller'}} />);
} else {
  const client = new ManualWaterClient('test-project','test-device');
  root.render(<HoldWaterControl client={client} pot={{pot:18,status:'ready',kind:'pairing',relayAddress:36,channel:18,pairingName:'Zone3-Pot18'}} />);
}
