
import { IRoute } from '../types/IRoute';

export const healthCheckRoute: IRoute = {
  method: 'GET',
  url: '/healthcheck',
  handler: async (request, reply) => {
    reply.send({ status: 'ok' });
  },
};