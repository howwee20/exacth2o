import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database';

class Valve extends Model {
  public id!: number
  public address!: string
  public relayAddress!: string
  public readonly createdAt!: Date
  public readonly updatedAt!: Date
}

Valve.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  address: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  relayAddress: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'valves',
  timestamps: true,
})

export default Valve