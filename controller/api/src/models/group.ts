import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../database';

class Group extends Model {
  public id!: number;
  public name!: string;
  public type!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Group.init({
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
  type: {
    type: DataTypes.ENUM('group', 'block', ''),
    allowNull: false,
    defaultValue: 'group',
  },
}, {
  sequelize,
  tableName: 'groups',
  timestamps: true,
});

export default Group;