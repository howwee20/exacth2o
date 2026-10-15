// Local browser test only. Never included in the public release.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HoldWaterControl} from '../src/HoldWaterControl';
import {supabase} from '../src/supabase';
import '../src/product/product.css';
supabase.auth.getSession = async () => ({data:{session:{access_token:'isolated-test-token'}},error:null}) as never;
createRoot(document.getElementById('root')!).render(<HoldWaterControl projectId="test-project" deviceId="test-device" pairing={{id:1,name:'Zone3-Pot18',pot_number:18,zone:3,source_sensor_id:1,source_valve_id:2,sensor_key:'test:R',valve_key:'0x24:18',wtc_percent_limit:35,valve_open_time_ms:4000,measurement_interval_ms:600000}}/>);
