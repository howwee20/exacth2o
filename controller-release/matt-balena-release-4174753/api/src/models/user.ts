import { DataTypes, Model } from 'sequelize'
import { sequelize } from '../database';

class User extends Model {
  public id!: number;
  public username!: string;
  public email!: string;
  public password!: string;
  public firstname!: string;
  public lastname!: string;
  public isAdmin!: boolean;
  public isActive!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

User.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  username: DataTypes.STRING,
  email: DataTypes.STRING,
  password: {
    type: DataTypes.STRING(60),
    allowNull: false
  },
  firstname: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: null
  },
  lastname: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: null
  },
  isAdmin: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0
  },
  isActive: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 1
  }
}, {
  sequelize,
  tableName: 'users',
  timestamps: true,
})

export default User