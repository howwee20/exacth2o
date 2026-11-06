import { QueryInterface } from 'sequelize';

const LOGS_CREATED_AT_INDEX = 'idx_logs_created_at';

async function indexExists(queryInterface: QueryInterface, tableName: string, indexName: string): Promise<boolean> {
  const indexes = await queryInterface.showIndex(tableName) as Array<{ name: string }>;
  return indexes.some((index) => index.name === indexName);
}

export const up = async (queryInterface: QueryInterface): Promise<void> => {
  if (!(await indexExists(queryInterface, 'logs', LOGS_CREATED_AT_INDEX))) {
    await queryInterface.addIndex('logs', ['createdAt'], {
      name: LOGS_CREATED_AT_INDEX,
    });
  }
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  if (await indexExists(queryInterface, 'logs', LOGS_CREATED_AT_INDEX)) {
    await queryInterface.removeIndex('logs', LOGS_CREATED_AT_INDEX);
  }
};
