import { QueryInterface } from 'sequelize';
import * as migration001 from './001-add-temperature-and-ec-to-readings';
import * as migration002 from './002-add-logs-created-at-index';
import * as migration003 from './003-add-logs-message-created-at-index';

interface Migration {
  name: string;
  up: (queryInterface: QueryInterface) => Promise<void>;
  down: (queryInterface: QueryInterface) => Promise<void>;
}

// List of all migrations in order
export const migrations: Migration[] = [
  {
    name: '001-add-temperature-and-ec-to-readings',
    up: migration001.up,
    down: migration001.down,
  },
  {
    name: '002-add-logs-created-at-index',
    up: migration002.up,
    down: migration002.down,
  },
  {
    name: '003-add-logs-message-created-at-index',
    up: migration003.up,
    down: migration003.down,
  },
];
