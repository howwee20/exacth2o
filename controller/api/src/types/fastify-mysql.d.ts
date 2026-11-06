import fastify from 'fastify'
import { MySQLPromiseConnection } from '@fastify/mysql'
// if you passed promise = true, type = 'connection'
declare module 'fastify' {
  interface FastifyInstance {
    mysql: MySQLPromiseConnection
  }
}