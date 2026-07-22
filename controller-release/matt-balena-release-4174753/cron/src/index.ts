import { readFile, writeFile, stat } from 'fs/promises'
import path from 'path'

import StateMachine from './StateMachine'
import { PairingState } from './types'
import { createServer } from './server'
import * as devtools from './debugCron'

const BOOTUP_INIT = (process.env.BOOTUP_INIT === 'true') || false
const ENVIRONMENT = process.env.NODE_ENV || 'development'
const ENABLE_FAKE_DATA = process.env.ENABLE_FAKE_DATA === 'true'
const INIT_FILE = process.env.INIT_FILE || `${path.join(__dirname, '..', 'init.json')}`
const apiURL = process.env?.API_URL || 'http://localhost:3000'
const PORT = Number(process.env?.PORT) || 3000
const pathPrefix = 'v1'

const stateMachine = new StateMachine(apiURL)
const server = createServer(stateMachine, { environment: ENVIRONMENT, port: PORT, apiURL, pathPrefix })
let shuttingDown = false

const gracefulShutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; closing active valves before exit`)
  try {
    await Promise.race([
      stateMachine.shutdown(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 10_000)),
    ])
  } catch (error) {
    console.error('Graceful shutdown encountered an error:', error)
  }
  try {
    await server.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })

const main = async () => {
  let init = false
  let initFileContents = { lastStartTime: new Date().toISOString(), pairings: [] } as { lastStartTime: string, pairings: PairingState[] }

  if (BOOTUP_INIT) {
    //check for existence of initialization file and read it
    const initFileExists = await stat(INIT_FILE).then(() => true).catch(() => false)

    if (initFileExists) {
      console.log(`Initialization file ${INIT_FILE} exists. Reading...`)
      const initConfig = await readFile(INIT_FILE, 'utf-8')
      initFileContents = JSON.parse(initConfig)
      console.log('Skipping state machine initialization. Init file contents:', initFileContents)
    } else {
      console.log(`Initialization file ${INIT_FILE} does not exist. Running state machine with initialization.`) // If the init file does not exist, we can assume that the state machine should be initialized with initialization
    }

    init = !initFileExists // If the file does not exist, we need to initialize the state machine
  }

  try {
    await stateMachine.init(init)

    console.log('State machine initialized.')
    // while (!stateMachine.pairingsLoaded()) {
    //   console.log('*')
    //   await new Promise(resolve => setTimeout(resolve, 1000))
    // }
    // console.log('Pairings loaded. Starting state machine.')
    await stateMachine.start()
    console.log('State machine started.')
    //save init file
    initFileContents.lastStartTime = new Date().toISOString()
    initFileContents.pairings = stateMachine.getAllPairingStates()
    console.log('Saving initialization file:', initFileContents)
    await writeFile(INIT_FILE, JSON.stringify(initFileContents, null, 2), 'utf-8')
    console.log('Initialization file saved.')
  } catch (error) {
    console.error('Error initializing state machine:', error)
    server.log.error({ err: error }, 'Error initializing state machine')
    process.exit(1)
  }
}

server.listen({ host: '::', port: PORT }, (err: any, address: any) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
  server.log.info(`server listening on ${address}`)
})

server.ready( (err) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
  console.log('Server is ready. Starting main function...')
  main().catch((error) => {
    console.error('Error starting state machine:', error)
    server.log.error('Error starting state machine:', error)
    process.exit(1)
  })
})


if (ENVIRONMENT === 'local' && ENABLE_FAKE_DATA) {
  // run the debug cron
  devtools.fakeDataInsertLoop()
}
