import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database'

class Sensor extends Model {
  public id!: number;
  public name!: string;
  public type!: string;
  public description!: string;
  public address!: string;
  public boardSerialId!: string;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Sensor.init({
  id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  type: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  address: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  boardSerialId: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
}, {
  sequelize,
  tableName: 'sensors',
  timestamps: true,
});

export default Sensor