import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../database';


class Calibration extends Model {
  public id!: number;
  public name!: string;
  public polynomialCoefficientsCommaDelimited!: string;
  public readingsJSONString!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Calibration.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  polynomialCoefficientsCommaDelimited: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  readingsJSONString: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  sequelize,
  tableName: 'calibrations',
  timestamps: true,
});

export default Calibration;