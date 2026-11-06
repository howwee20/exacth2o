import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../database';


class Rule extends Model {
  public id!: number;
  public name!: string;
  public isActive!: boolean;
  public ruleJSON!: Buffer;
  public readonly created!: Date;
  public readonly updated!: Date;
}

Rule.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  ruleJSON: {
    type: DataTypes.BLOB,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'rules',
  timestamps: true,
});

export default Rule;