import { Sequelize, DataTypes } from 'sequelize';
import { migrations } from './index';

/**
 * Runs all pending migrations
 * @param sequelize - Sequelize instance
 */
export async function runMigrations(sequelize: Sequelize): Promise<void> {
  const queryInterface = sequelize.getQueryInterface();

  // Create a migrations tracking table if it doesn't exist
  const tableExists = await queryInterface.showAllTables().then((tables) =>
    tables.includes('schema_migrations')
  );

  if (!tableExists) {
    await queryInterface.createTable('schema_migrations', {
      name: {
        type: DataTypes.STRING(255),
        primaryKey: true,
        allowNull: false,
      },
      applied_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  }

  // Get list of already applied migrations
  const appliedMigrations = await sequelize.query(
    'SELECT name FROM schema_migrations',
    { type: 'SELECT' }
  ) as Array<{ name: string }>;

  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  // Run pending migrations
  for (const migration of migrations) {
    if (!appliedNames.has(migration.name)) {
      console.log(`Running migration: ${migration.name}`);
      try {
        await migration.up(queryInterface);
        await sequelize.query(
          'INSERT INTO schema_migrations (name) VALUES (?)',
          { replacements: [migration.name] }
        );
        console.log(`✓ Migration ${migration.name} completed successfully`);
      } catch (error) {
        console.error(`✗ Migration ${migration.name} failed:`, error);
        throw error;
      }
    } else {
      console.log(`Skipping already applied migration: ${migration.name}`);
    }
  }

  console.log('All migrations completed');
}
