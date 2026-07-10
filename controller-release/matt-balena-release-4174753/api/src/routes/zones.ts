import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Zone from '../models/zone'; // Import the Zone model

const getZones = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const zones = await Zone.findAll();
    reply.send(zones);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getZone = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const zone = await Zone.findByPk(id);
    if (zone) {
      reply.send(zone);
    } else {
      reply.code(404).send({ message: 'Zone not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createZone = async (request: FastifyRequest<{ Body: { name: string } }>, reply: FastifyReply) => {
  const { name } = request.body;
  try {
    const zone = await Zone.create({ name });
    reply.send(zone);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateZone = async (request: FastifyRequest<{ Params: { id: string }, Body: { name: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  const { name } = request.body;
  try {
    const zone = await Zone.findByPk(id);
    if (zone) {
      zone.name = name;
      await zone.save();
      reply.send(zone);
    } else {
      reply.code(404).send({ message: 'Zone not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteZone = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const zone = await Zone.findByPk(id);
    if (zone) {
      await zone.destroy();
      reply.send({ message: 'Zone deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Zone not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllZonesRoute: IRoute = {
  method: 'GET',
  url: '/zones',
  handler: getZones
}

export const getZoneByIdRoute: IRoute = {
  method: 'GET',
  url: '/zones/:id',
  handler: getZone
}

export const createZoneRoute: IRoute = {
  method: 'POST',
  url: '/zones',
  handler: createZone
}

export const updateZoneRoute: IRoute = {
  method: 'PUT',
  url: '/zones/:id',
  handler: updateZone
}

export const deleteZoneRoute: IRoute = {
  method: 'DELETE',
  url: '/zones/:id',
  handler: deleteZone
}