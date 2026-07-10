import { useState } from "react";
import { useSensors } from "./swr/useSensors";
import { MachineState, Pairing, Valve } from "./lib/types";
import { getAllValves } from "./server-actions/getValves";
import { getAllPairings } from "./server-actions/pairingsCRUD";
import { useSystem } from "./swr/useLockedStatus";
import { updateSystemState } from "./server-actions/systemCRUD";

// import { useValves } from "./swr/useValves";
export function DebugSensorsList() {
  const { sensors, error, isLoading } = useSensors();
  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error loading sensors</div>;

  return (
    <div>
      <p>All Sensors (connected or not)</p>
      <ul>
        {sensors?.map(sensor => (
          <li key={sensor.id}>{sensor.id}</li>
        ))}
      </ul>
    </div>
  );
}

export function DebugValvesList() {
  const [valves, setValves] = useState<Valve[]>([]);
  const [error, setError] = useState<Error | null>(null);



  return (
    <>
      {error && <div>Error loading valves: {error.message}</div>}
      {!error &&
        <div>
          <p>---All Valves (connected or not)---</p>
      <ul>
        {valves?.map(valve => (
          <li className="border p-1 border-blue-200 w-fit" key={valve.id}>{valve.id} - {valve.address} - {valve.relayAddress}</li>
        ))}
      </ul>
      <button className="border rounded-xl p-2 mt-2" onClick={() => {
        getAllValves().then(valves => {
          setValves(valves);
        }).catch(error => {
          console.error(error);
          setError(error);
          });
        }}>Fetch Valves</button>
      </div>
    }
    </>
  );
}


export function DebugPairingsList() {
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [error, setError] = useState<Error | null>(null);
  return (
    <>
      {error && <div>Error loading valves: {error.message}</div>}
      {!error &&
        <div>
          <p>---All Pairings---</p>
      <ol>
        {pairings?.map((pairing, index) => (
          <li className="border p-1 border-purple-300 w-fit" key={index}>{pairing.groupId} - {pairing.valveId} - {pairing.sensorId}</li>
        ))}
      </ol>
      <button className="border rounded-xl p-2 mt-2" onClick={() => {
        getAllPairings().then(pairings => {
          setPairings(pairings);
        }).catch(error => {
          console.error(error);
          setError(error);
          });
        }}>Fetch Pairings</button>
      </div>
    }
    </>
  );
}


export function LockButton() {
  const { lockedStatus, mutate: mutateSystem } = useSystem()

  return (
    <button className="border rounded-xl p-2 mt-2" onClick={() => {
      updateSystemState(lockedStatus ? MachineState.STOPPED : MachineState.STARTUP).then(() => {
        mutateSystem()
      }).catch(error => {
        console.error(error)
      })
    }}>Debug: Toggle Lock</button>
  )
}