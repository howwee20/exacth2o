import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import User from '../models/user';
import bcrypt from 'bcryptjs';
import { secretsMatch } from '../utils/controllerMutationAuth';

const safeUserAttributes = ['id', 'username', 'email', 'firstname', 'lastname', 'isAdmin', 'isActive', 'createdAt', 'updatedAt'];

const safeUser = (user: User) => {
  const value = user.toJSON() as Record<string, unknown>;
  delete value.password;
  return value;
}

const passwordMatches = async (user: User, suppliedPassword: string): Promise<boolean> => {
  const storedPassword = String(user.password || '');
  const matches = storedPassword.startsWith('$2')
    ? await bcrypt.compare(suppliedPassword, storedPassword)
    : secretsMatch(suppliedPassword, storedPassword);
  if (matches && !storedPassword.startsWith('$2')) {
    user.password = await bcrypt.hash(suppliedPassword, 10);
    await user.save();
  }
  return matches;
}

const getUsers = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const users = await User.findAll({
      attributes: safeUserAttributes
    });
    reply.send(users);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getUser = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const user = await User.findByPk(id, {
      attributes: safeUserAttributes
    });
    if (user) {
      reply.send(user);
    } else {
      reply.send(null);
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getUserByEmail = async (request: FastifyRequest<{ Params: { email: string } }>, reply: FastifyReply) => {
  const { email } = request.params;
  try {
    const user = await User.findOne({
      where: { email },
      attributes: safeUserAttributes
    });
    if (user) {
      reply.send(user);
    } else {
      reply.send(null);
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const authenticateUser = async (request: FastifyRequest<{ Body: { email: string, password: string } }>, reply: FastifyReply) => {
  const email = String(request.body?.email || '').trim();
  const password = String(request.body?.password || '');
  const user = await User.findOne({ where: { email } });
  if (!user || !user.isActive || !(await passwordMatches(user, password))) {
    return reply.code(401).send({ message: 'Invalid email or password' });
  }
  return reply.send(safeUser(user));
}

const createUser = async (request: FastifyRequest<{
  Body: {
    username: string,
    email: string,
    password: string,
    firstname: string,
    lastname: string,
    isAdmin: boolean,
    isActive: boolean,
    adminPassword: string
  }
}>, reply: FastifyReply) => {
  const {
    username,
    email,
    password,
    firstname,
    lastname,
    isAdmin,
    isActive,
    adminPassword
  } = request.body;
  try {
    if (!adminPassword) {
      reply.code(401).send({ message: 'Unauthorized' });
      return;
    }

    let adminUsers = await User.findAll({
      where: {
        isAdmin: true
      }
    })

    if (adminUsers.length === 0) {
      const defaultAdminPassword = process.env.ADMIN_PASSWORD;
      if (!defaultAdminPassword || !secretsMatch(adminPassword, defaultAdminPassword)) {
        reply.code(503).send({ message: 'Initial administrator is not configured' });
        return;
      }
      adminUsers = [
        await User.create({ username: 'admin', email: 'admin@admin.com', password: await bcrypt.hash(defaultAdminPassword, 10), firstname: 'Admin', lastname: 'Admin', isAdmin: true, isActive: true })
      ];
    }

    const verifiedAdmins = await Promise.all(adminUsers.map(user => passwordMatches(user, adminPassword)));
    if (verifiedAdmins.some(Boolean)) {
      const user = await User.create({ username, email, password: await bcrypt.hash(password, 10), firstname, lastname, isAdmin, isActive });
      reply.send(safeUser(user));
    } else {
      reply.code(401).send({ message: 'Unauthorized' });
      return;
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateUser = async (request: FastifyRequest<{
  Params: { id: string }, Body: {
    username?: string,
    email?: string,
    password?: string,
    firstname?: string,
    lastname?: string,
    isAdmin?: boolean,
    isActive?: boolean
  }
}>, reply: FastifyReply) => {
  const { id } = request.params;
  const { username, email, password, firstname, lastname, isAdmin, isActive } = request.body;
  try {
    const user = await User.findByPk(id);
    if (user) {
      if (username) user.username = username;
      if (email) user.email = email;
      if (password) user.password = await bcrypt.hash(password, 10);
      if (firstname) user.firstname = firstname;
      if (lastname) user.lastname = lastname;
      if (isAdmin !== undefined) user.isAdmin = isAdmin;
      if (isActive !== undefined) user.isActive = isActive;

      await user.save();
      reply.send(safeUser(user));
    } else {
      reply.code(404).send({ message: 'User not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteUser = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const user = await User.findByPk(id);
    if (user) {
      await user.destroy();
      reply.send({ message: 'User deleted successfully' });
    } else {
      reply.code(404).send({ message: 'User not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllUsersRoute: IRoute = {
  method: 'GET',
  url: '/users',
  handler: getUsers
}

export const getUserByIdRoute: IRoute = {
  method: 'GET',
  url: '/users/:id',
  handler: getUser
}

export const getUserByEmailRoute: IRoute = {
  method: 'GET',
  url: '/users/email/:email',
  handler: getUserByEmail
}

export const authenticateUserRoute: IRoute = {
  method: 'POST',
  url: '/users/authenticate',
  handler: authenticateUser
}

export const createUserRoute: IRoute = {
  method: 'POST',
  url: '/users',
  handler: createUser
}

export const updateUserRoute: IRoute = {
  method: 'PUT',
  url: '/users/:id',
  handler: updateUser
}

export const deleteUserRoute: IRoute = {
  method: 'DELETE',
  url: '/users/:id',
  handler: deleteUser
}
