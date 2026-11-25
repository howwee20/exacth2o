import { MachineHome, MachineTile } from "./MachineTile";

// The demo account: one system with two benches, each running its own experiment. It is the same home screen a
// signed-in account sees, with sample experiments behind the tiles.
const benches = [
  { name: "Bench A", experiment: "experiment-1", running: "Drought response" },
  { name: "Bench B", experiment: "experiment-2", running: "Recovery after drought" },
];

export function DemoHome() {
  return <>
    <h1 className="px-sr-only">Your systems</h1>
    <MachineHome>
      {benches.map((bench) => <MachineTile key={bench.name} name={bench.name} experiments={[{ id: bench.experiment, name: bench.running }]} status="Online" statusTone="online"
        to={{ view: "experiment", experiment: bench.experiment, tab: "pots", pot: null }}
        creation={{ unavailable: "New experiments are not available in the demo." }} />)}
    </MachineHome>
  </>;
}
