import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database'

export enum MachineState {
  STARTUP = 'STARTUP',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  UPDATE = 'UPDATE',
  RESET = 'RESET',
  UNKNOWN = 'UNKNOWN',
  ERROR = 'ERROR',
}

export interface BoardConfig {
  address: number;
  resetPin?: number;
}


class System extends Model {
  public id!: number;
  public state!: MachineState;
  public configuration!: {
    boardConfigs?: BoardConfig[] //  interface BoardConfig { address: number; resetPin?: number; }
  };
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

System.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    defaultValue: 1,
  },
  state: {
    type: DataTypes.ENUM('STARTUP', 'RUNNING', 'STOPPED', 'UPDATE', 'RESET', 'UNKNOWN', 'ERROR'),
    allowNull: false,
    defaultValue: 'STOPPED',
  },
  configuration: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: { boardConfigs: [] },
  },
}, {
  sequelize,
  tableName: 'systems',
  timestamps: true,
});

export default System