import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../database';

import Sensor from './sensor'; // Adjust the import path based on your project structure

class Reading extends Model {
  public id!: number;
  public sensorId!: number;
  public rawValue!: number;
  public calibratedValue!: number;
  public temperature?: number | null;
  public electricalConductivity?: number | null;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Reading.init({
  id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    autoIncrement: true,
  },
  sensorId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Sensor,
      key: 'id',
    },
  },
  rawValue: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
  calibratedValue: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  temperature: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  electricalConductivity: {
    type: DataTypes.FLOAT,
    allowNull: true,
  }
}, {
  sequelize,
  tableName: 'readings',
  timestamps: true,
});

Sensor.hasMany(Reading, { foreignKey: 'sensorId' });
Reading.belongsTo(Sensor, { foreignKey: 'sensorId' });

export default Reading;