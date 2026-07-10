import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../database';
import Sensor from './sensor';
import Valve from './valve';
import Calibration from './calibration';
import Group from './group';

class Pairing extends Model {
  public sensorId!: number;
  public valveId!: number;
  public groupId!: number;
  public name!: string;
  public WTCPercentLimit!: number;
  public ValveOpenTime!: number;
  public MeasurementInterval!: number;
  public calibrationId!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Pairing.init({
  sensorId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    references: {
      model: 'sensors',
      key: 'id'
    }
  },
  valveId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    references: {
      model: 'valves',
      key: 'id'
    }
  },
  calibrationId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'calibrations',
      key: 'id'
    },
  },
  groupId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'groups',
      key: 'id'
    }
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  WTCPercentLimit: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  ValveOpenTime: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  MeasurementInterval: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  sequelize,
  tableName: 'pairings',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['sensorId', 'valveId', 'calibrationId'],
    },
  ],
});

// Setup associations
Pairing.belongsTo(Sensor, {
  foreignKey: 'sensorId',
  onDelete: 'CASCADE'
});
Pairing.belongsTo(Valve, {
  foreignKey: 'valveId',
  onDelete: 'CASCADE'
});
Pairing.belongsTo(Calibration, {
  foreignKey: 'calibrationId',
  onDelete: 'SET NULL'
});
Pairing.belongsTo(Group, {
  foreignKey: 'groupId',
  onDelete: 'SET NULL'
});

export default Pairing;
