import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database'

class Log extends Model {
  public id!: number
  public level!: string
  public message!: string
  public data!: Record<string, any>
  public readonly createdAt!: Date
  public readonly updatedAt!: Date
}

Log.init({
  id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
    autoIncrement: true,
  },
  level: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  message: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  source: { // Could be anything, or nothing, just figured id add
    type: DataTypes.STRING,
    allowNull: true,
  },
  data: {   // Catch all for anything else.  We can add a dropdown to the logs
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  sequelize,
  tableName: 'logs',
  timestamps: true,
})

export default Log