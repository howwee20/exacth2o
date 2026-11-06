import { Sequelize } from 'sequelize'

const DB_CONN = process.env.DB_CONN || 'mysql://root@localhost/mysql'

function maskConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return connectionString
  }
}

console.log(`DB_CONN=${maskConnectionString(DB_CONN)}`)

const isProduction = process.env.NODE_ENV === 'production';
const sequelize = new Sequelize(DB_CONN, {
  logging: console.log,
  sync: { force: !isProduction }, // Enable force only in non-production environments
  dialect: 'mariadb',
})

type WaitForDbOptions = {
  maxAttempts: number
  delayMs: number
}

export async function waitForDatabaseReady(
  options: Partial<WaitForDbOptions> = {}
): Promise<void> {
  const maxAttempts = Number(options.maxAttempts ?? process.env.DB_CONNECT_MAX_ATTEMPTS ?? 30)
  const delayMs = Number(options.delayMs ?? process.env.DB_CONNECT_DELAY_MS ?? 2000)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sequelize.authenticate()
      console.log('Database connection established')
      return
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Database not ready (attempt ${attempt}/${maxAttempts}): ${message}`)

      if (isLastAttempt) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export { sequelize, DB_CONN }