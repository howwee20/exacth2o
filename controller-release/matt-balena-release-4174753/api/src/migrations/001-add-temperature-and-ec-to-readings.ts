import { QueryInterface, DataTypes } from 'sequelize';

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  const table = await queryInterface.describeTable('readings');

  if (!table.temperature) {
    await queryInterface.addColumn('readings', 'temperature', {
      type: DataTypes.FLOAT,
      allowNull: true,
    });
  }

  if (!table.electricalConductivity) {
    await queryInterface.addColumn('readings', 'electricalConductivity', {
      type: DataTypes.FLOAT,
      allowNull: true,
    });
  }
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  // Remove electricalConductivity column
  await queryInterface.removeColumn('readings', 'electricalConductivity');

  // Remove temperature column
  await queryInterface.removeColumn('readings', 'temperature');
};
