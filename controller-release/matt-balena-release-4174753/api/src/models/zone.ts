import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database'

class Zone extends Model {
  public id!: number
  public name!: string
  public readonly createdAt!: Date
  public readonly updatedAt!: Date
}

Zone.init({
  id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'zones',
  timestamps: true,
})

export default Zone