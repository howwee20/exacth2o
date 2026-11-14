const fs = require('node:fs');
const { Sensor, Reading } = require('./dist/models');
const { default: Calibration } = require('./dist/models/calibration');
const { sequelize } = require('./dist/database');

async function main() {
  const batch = JSON.parse(fs.readFileSync(0, 'utf8'));
  sequelize.options.logging = false;
  const calibration = await Calibration.findOne({ where: { name: batch.calibration_name } });
  if (!calibration) throw new Error('Configured calibration is missing');
  const coefficients = calibration.polynomialCoefficientsCommaDelimited.split(',').map(Number);
  if (JSON.stringify(coefficients) !== JSON.stringify(batch.coefficients)) {
    throw new Error('Calibration coefficients changed, pending observations require review');
  }
  let inserted = 0;
  await sequelize.transaction(async transaction => {
    for (const observation of batch.observations) {
      const sensor = await Sensor.findByPk(observation.sensor.id, { transaction });
      if (!sensor || sensor.address !== observation.sensor.address ||
          sensor.boardSerialId !== batch.board_serial ||
          !(sensor.description || '').includes(observation.sensor.serial)) {
        throw new Error(`Sensor identity mismatch at address ${observation.sensor.address}`);
      }
      const rawValue = Number(observation.raw_value);
      const temperature = Number(observation.temperature);
      const createdAt = new Date(observation.recorded_at);
      if (!Number.isFinite(rawValue) || rawValue < 0 || !Number.isFinite(temperature) ||
          temperature < -40 || temperature > 60 || !Number.isFinite(createdAt.getTime())) {
        throw new Error('Invalid sensor observation');
      }
      const calibratedValue = coefficients.reduceRight((value, coefficient) => value * rawValue + coefficient, 0);
      if (!Number.isFinite(calibratedValue)) throw new Error('Invalid calibration result');
      const prior = await Reading.findOne({ where: { sensorId: sensor.id, createdAt }, transaction });
      if (prior) continue;
      await Reading.create({ sensorId: sensor.id, rawValue, calibratedValue,
        temperature, electricalConductivity: null, createdAt, updatedAt: createdAt }, { transaction });
      inserted += 1;
    }
  });
  console.log(JSON.stringify({ inserted, observations: batch.observations.length }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
