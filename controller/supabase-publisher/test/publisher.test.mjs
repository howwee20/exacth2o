import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyCursorId,
  pairingNameAt,
  readingEvent,
  selectOldestUnseenRows,
} from "../src/publisher.mjs";

const history = {
  changes: [
    {
      changedAt: "2026-07-26T18:08:26.000Z",
      mappings: [
        {
          sensorId: 641,
          beforePairingName: "Zone1-Pot19",
          afterPairingName: "Zone3-Pot69",
        },
      ],
    },
  ],
};

test("migrates the cursor from the legacy event-id ledger", () => {
  assert.equal(
    legacyCursorId({
      sentEventIds: [
        "live-device:reading:84903",
        "live-device:reading:84905",
        "invalid",
      ],
    }),
    84905,
  );
});

test("uses the historical pairing name on each side of the mapping boundary", () => {
  const pairing = {
    name: "Zone3-Pot69",
    Sensor: { boardSerialId: "D30GQN2E", address: "S" },
  };
  assert.equal(
    pairingNameAt(
      { sensorId: 641, createdAt: "2026-07-26T18:08:25.999Z" },
      pairing,
      history,
    ),
    "Zone1-Pot19",
  );
  assert.equal(
    pairingNameAt(
      { sensorId: 641, createdAt: "2026-07-26T18:08:26.000Z" },
      pairing,
      history,
    ),
    "Zone3-Pot69",
  );
});

test("deduplicates overlapping pages and returns only the bounded unseen range", () => {
  const rows = selectOldestUnseenRows(
    [
      { data: [{ id: 12 }, { id: 11 }, { id: 10 }] },
      { data: [{ id: 10 }, { id: 9 }, { id: 8 }] },
    ],
    8,
    11,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [9, 10, 11],
  );
});

test("builds deterministic event ids without relabeling historical readings", () => {
  const event = readingEvent(
    {
      id: 84906,
      sensorId: 641,
      createdAt: "2026-07-26T17:00:00.000Z",
      rawValue: 1,
      calibratedValue: 2,
      temperature: 3,
      electricalConductivity: 4,
    },
    {
      name: "Zone3-Pot69",
      Sensor: { boardSerialId: "D30GQN2E", address: "S" },
    },
    history,
  );
  assert.equal(event.event_id, "live-device:reading:84906");
  assert.equal(event.pairing_name, "Zone1-Pot19");
  assert.equal(event.sensor_key, "D30GQN2E:S");
});
