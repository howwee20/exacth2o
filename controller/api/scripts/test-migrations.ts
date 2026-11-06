import { Sequelize, DataTypes } from 'sequelize';
import { runMigrations } from '../src/migrations/runner';
import { join } from 'path';
import { unlink } from 'fs/promises';

const TEST_DB_PATH = join(__dirname, 'test-migration.sqlite');

async function testMigrations() {
  console.log('Starting migration test...\n');

  // Create a test database
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: TEST_DB_PATH,
    logging: false,
  });

  try {
    // Create the readings table without the new columns
    await sequelize.getQueryInterface().createTable('readings', {
      id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true,
        autoIncrement: true,
      },
      sensorId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      rawValue: {
        type: DataTypes.FLOAT,
        allowNull: false,
      },
      calibratedValue: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });

    console.log('✓ Created readings table without temperature and electricalConductivity columns');

    // Describe table before migration
    const tableDescBefore = await sequelize.getQueryInterface().describeTable('readings');
    console.log('\nColumns before migration:', Object.keys(tableDescBefore));

    // Verify the columns don't exist yet
    if (tableDescBefore.temperature || tableDescBefore.electricalConductivity) {
      throw new Error('Temperature or EC columns already exist before migration!');
    }
    console.log('✓ Confirmed columns do not exist before migration');

    // Run migrations
    console.log('\nRunning migrations...');
    await runMigrations(sequelize);

    // Describe table after migration
    const tableDescAfter = await sequelize.getQueryInterface().describeTable('readings');
    console.log('\nColumns after migration:', Object.keys(tableDescAfter));

    // Verify the columns were added
    if (!tableDescAfter.temperature) {
      throw new Error('Temperature column was not added!');
    }
    if (!tableDescAfter.electricalConductivity) {
      throw new Error('ElectricalConductivity column was not added!');
    }
    console.log('✓ Confirmed temperature and electricalConductivity columns were added');

    // Verify schema_migrations table exists and has the migration recorded
    const schemaMigrations = await sequelize.query(
      'SELECT * FROM schema_migrations',
      { type: 'SELECT' }
    ) as Array<{ name: string }>;

    console.log('\nApplied migrations:', schemaMigrations.map(m => m.name));

    const hasMigration = schemaMigrations.some(
      m => m.name === '001-add-temperature-and-ec-to-readings'
    );
    if (!hasMigration) {
      throw new Error('Migration was not recorded in schema_migrations table!');
    }
    console.log('✓ Migration was properly recorded');

    // Test idempotency - run migrations again
    console.log('\nTesting idempotency (running migrations again)...');
    await runMigrations(sequelize);
    console.log('✓ Migrations ran successfully a second time (idempotent)');

    console.log('\n✅ All migration tests passed!\n');
  } catch (error) {
    console.error('\n❌ Migration test failed:', error);
    throw error;
  } finally {
    await sequelize.close();
    // Clean up test database
    try {
      await unlink(TEST_DB_PATH);
      console.log('Test database cleaned up');
    } catch (err) {
      console.warn('Warning: Failed to clean up test database at', TEST_DB_PATH, 'Error:', err);
    }
  }
}

// Run the test
testMigrations()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
