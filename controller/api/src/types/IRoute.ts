import { FastifyRequest, FastifyReply } from 'fastify';

export interface IRoute {
  method: string
  url: string
  handler: (request: FastifyRequest<any>, reply: FastifyReply) => Promise<any> | void
}
