import { describe, expect, it } from "vitest";
import { experimentHistoryAliases, gapsAcrossPairingAliases } from "./experimentHistory";

describe("experiment record across physical zone corrections", () => {
  const current = [{pairing_name:"Zone3-Pot16",sensor_key_snapshot:"board-E:P"}];
  const history = [
    {pairing_name:"Zone1-Pot16",sensor_key_snapshot:"board-E:P"},
    {pairing_name:"Zone3-Pot66",sensor_key_snapshot:"board-D:P"},
    {pairing_name:"Zone3-Pot64",sensor_key_snapshot:"board-E:N"},
  ];
  it("includes earlier labels for the same probe and excludes removed or other-board sensors", () => {
    expect([...experimentHistoryAliases(["Zone3-Pot16"],current,history)]).toEqual([
      ["Zone3-Pot16","Zone3-Pot16"],["Zone1-Pot16","Zone3-Pot16"],
    ]);
  });
  it("joins hourly presence before deriving gaps, so a rename does not invent an outage", () => {
    const aliases=experimentHistoryAliases(["Zone3-Pot16"],current,history),hour=3_600_000;
    const buckets=[0,1,2,3].map(i=>({pairingName:i<2?"Zone1-Pot16":"Zone3-Pot16",startMs:i*hour,readings:1}));
    expect(gapsAcrossPairingAliases(buckets,aliases,0,4*hour)).toEqual([]);
    expect(gapsAcrossPairingAliases(buckets.filter(b=>b.startMs===0||b.startMs===3*hour),aliases,0,4*hour)).toEqual([
      {pairingName:"Zone3-Pot16",startMs:hour,endMs:3*hour,ongoing:false},
    ]);
    expect(gapsAcrossPairingAliases(buckets.slice(0,2),aliases,0,4*hour)).toEqual([
      {pairingName:"Zone3-Pot16",startMs:2*hour,endMs:4*hour,ongoing:true},
    ]);
  });
});
