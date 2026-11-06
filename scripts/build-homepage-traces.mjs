// Export the same readings and physical-pot colors used by both public demos.
// Relative study hours make this committed static asset reproducible.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../research-portal/node_modules/vite/dist/node/index.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root: repo, configFile: false, publicDir: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true }, appType: 'custom' });
try {
  const { fixture } = await server.ssrLoadModule('/demo-preview/fixtures.ts');
  const { colorForPotNumber } = await server.ssrLoadModule('/research-portal/src/potColors.ts');
  const byPot = new Map();
  for (const reading of fixture.historyReadings) {
    if (!byPot.has(reading.pairing_name)) byPot.set(reading.pairing_name, []);
    byPot.get(reading.pairing_name).push(reading);
  }
  const experiments = fixture.experiments.filter(experiment => experiment.id === 'experiment-1').map(experiment => {
    const first = byPot.get(experiment.assignments[0].pairing_name);
    const stride = Math.ceil(first.length / 1600);
    const indices = Array.from({ length: Math.ceil(first.length / stride) }, (_, i) => i * stride);
    if (indices.at(-1) !== first.length - 1) indices.push(first.length - 1);
    const start = Date.parse(first[0].device_recorded_at);
    const hours = indices.map(i => Number(((Date.parse(first[i].device_recorded_at) - start) / 3600000).toFixed(6)));
    const pots = experiment.assignments.map(assignment => {
      const rows = byPot.get(assignment.pairing_name);
      if (rows.length !== first.length) throw new Error('Demo series clocks differ.');
      const values = indices.map(i => {
        if (rows[i].device_recorded_at !== first[i].device_recorded_at) throw new Error('Demo readings are misaligned.');
        return rows[i].calibrated_value;
      });
      return { number: assignment.pot_number, color: colorForPotNumber(assignment.pot_number),
        group: assignment.recovery || assignment.crop || assignment.treatment, values };
    });
    const values = pots.flatMap(pot => pot.values);
    return { id: experiment.id, name: experiment.name,
      kind: experiment.id === 'experiment-1' ? 'Recorded study' : 'Demo simulation',
      initialHour: experiment.id === 'experiment-2' ? 112 : 72,
      min: Math.floor(Math.min(...values) / 5) * 5,
      max: Math.ceil(Math.max(...values) / 5) * 5,
      hours, pots };
  });
  writeFileSync(new URL('../homepage-traces-data.json', import.meta.url), JSON.stringify({ experiment: experiments[0] }) + '\n');
  console.log('Exported the homepage study from the shared demo fixtures.');
} finally {
  await server.close();
}
