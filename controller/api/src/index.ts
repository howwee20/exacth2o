import path from 'path'
import { readFile, writeFile, stat } from 'fs/promises'
// standard fastify api setup
import fastify, { FastifyRequest, FastifyReply } from 'fastify'
import fastifyCors from '@fastify/cors'
import { sequelize, DB_CONN, waitForDatabaseReady } from './database'
import { checkModels } from './models/index'
import { RouteConfigurator, routes } from './routes'
import { runMigrations } from './migrations/runner'


// config consts
const ENVIRONMENT = process.env.NODE_ENV || 'development'
const INIT_FILE = process.env.INIT_FILE || `${path.join(__dirname, '..', 'init.json')}`
const PORT = Number(process.env.PORT) || 8080

const envToLogger: any = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
  production: true,
  test: false,
}

// Create a Fastify server
const server = fastify({
  logger: envToLogger[ENVIRONMENT] ?? true // defaults to true if no entry matches in the map
})

server.register(fastifyCors, {
  origin: true, // Allow all origins for local development
})


const main = async () => {
  // On balena (and other orchestrated environments), services can start before
  // the DB is ready to accept connections.
  await waitForDatabaseReady()

  // Register the MySQL plugin after DB is reachable
  await server.register(require('@fastify/mysql'), {
    promise: true,
    connectionString: DB_CONN
  })

  //check for existence of initialization file and read it
  const initFileExists = await stat(INIT_FILE).then(() => true).catch(() => false)
  let initFileContents = { lastStartTime: new Date().toISOString() } as { lastStartTime: string }

  if (initFileExists) {
    console.log(`Initialization file ${INIT_FILE} exists. Reading...`)
    const initConfig = await readFile(INIT_FILE, 'utf-8')
    initFileContents = JSON.parse(initConfig)
    console.log('Initialization file contents:', initFileContents)
  } else {
    console.log(`Initialization file ${INIT_FILE} does not exist. Sequelize initialization.`)
    checkModels(sequelize)
    // Ensure all tables are created
    await sequelize.sync() // { force: true } // do not force a table drop on start
    console.log("models: ", sequelize.models)
    console.log('Database synchronized')
  }

  // Run database migrations (for both new and existing installations)
  console.log('Running database migrations...')
  await runMigrations(sequelize)

  // Register routes
  console.log('Registering routes...')
  RouteConfigurator(server, routes)

  // Start the server
  const address = await server.listen({ host: '::', port: PORT })
  server.log.info(`Server listening on ${address}`)
  initFileContents.lastStartTime = new Date().toISOString()
  console.log('Saving initialization file:', initFileContents)
  await writeFile(INIT_FILE, JSON.stringify(initFileContents, null, 2), 'utf-8')
  console.log('Initialization file saved.')
}

main().catch((error) => {
  console.error('Error starting API server:', error)
  server.log.error({ err: error }, 'Error starting API server')
  process.exit(1)
})

export { server }

function syncModels() {
  throw new Error('Function not implemented.')
}
