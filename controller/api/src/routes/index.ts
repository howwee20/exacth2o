import { FastifyInstance } from "fastify"
import { IRoute } from "../types/IRoute"
import { healthCheckRoute } from "./healthcheck"
import * as groupRoutes from "./groups"
import * as zoneRoutes from "./zones"
import * as valveRoutes from "./valves"
import * as sensorRoutes from "./sensors"
import * as ruleRoutes from "./rules"
import * as readingRoutes from "./readings"
import * as userRoutes from "./users"
import * as pairingRoutes from "./pairings"
import * as logsRoutes from "./logs"
import { logsRoutes as orderedLogsRoutes } from "./logs"
import * as systemRoutes from "./system"
import * as calibrationRoutes from "./calibrations"
import { guardedControllerMutation } from "../utils/controllerMutationGate"

export const routes: IRoute[] = [
  healthCheckRoute,
  ...Object.values(groupRoutes),
  ...Object.values(zoneRoutes),
  ...Object.values(valveRoutes),
  ...Object.values(sensorRoutes),
  ...Object.values(ruleRoutes),
  ...Object.values(readingRoutes),
  ...Object.values(userRoutes),
  ...Object.values(pairingRoutes),
  ...orderedLogsRoutes, // Use explicit ordered array to ensure deterministic registration
  ...Object.values(systemRoutes),
  ...Object.values(calibrationRoutes),
]

export const RouteConfigurator = (server: FastifyInstance, routes: IRoute[], pathPrefix: string = 'v1') => {
  const b = Object.values(readingRoutes)

  routes.forEach((route) => {
    const url = `/${pathPrefix}${route.url}`
    server.log.info(`Registering route ${url}`)
    server.route({
      method: route.method,
      url,
      handler: (request, reply) => guardedControllerMutation(
        route.method,
        route.url,
        request,
        reply,
        () => route.handler(request, reply),
      ),
    })
  })
}
