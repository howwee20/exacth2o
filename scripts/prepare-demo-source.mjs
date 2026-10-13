// Lossless, column-oriented browser payload from Binod's original attachment.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../demo-preview/data/', import.meta.url);
const csv = readFileSync(new URL('ExactH2O_dummy_interface.csv', root), 'utf8');
const lines = csv.trim().split(/\r?\n/).map(line => line.split(','));
const headers = lines.shift();
const channels = ['A', 'B', 'C', 'E', 'G', 'H', 'L', 'M', 'N', 'O'];
const rows = lines.map(row => Object.fromEntries(headers.map((key, i) => [key, row[i]])));
// Parse the source clock literally, without guessing its unrecorded timezone.
const clock = value => Date.parse(value.replace(' ', 'T') + 'Z');
const first = clock(rows[0].Date);
const data = {
  filename: 'ExactH2O_dummy_interface.csv',
  sha256: createHash('sha256').update(csv).digest('hex'),
  dates: rows.map(row => row.Date),
  measurementIds: rows.map(row => Number(row.Measurement_ID)),
  minutes: rows.map(row => (clock(row.Date) - first) / 60000),
  channels: Object.fromEntries(channels.map(channel => [channel, {
    moisture: rows.map(row => Number(row[`${channel}_vwc`])),
    temperature: rows.map(row => Number(row[`${channel}_temp`])),
  }])),
};
if (data.minutes.some((minute, i) => !Number.isFinite(minute) || (i > 0 && minute <= data.minutes[i - 1]))) throw new Error('Invalid source chronology');
for (const values of Object.values(data.channels)) for (const series of Object.values(values)) if (series.some(value => !Number.isFinite(value))) throw new Error('Missing source measurement');
writeFileSync(new URL('binod-source.json', root), JSON.stringify(data) + '\n');
console.log(`${rows.length} timestamps, ${channels.length} selected channels; original values preserved.`);
