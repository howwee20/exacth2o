'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'
import { User } from '@/app/lib/types';
import { clearUiSession, createUiSession, requireUiSession } from '@/app/lib/server-auth';

export async function getUser(email: string, password: string): Promise<User | null> {
  const apiClient = new ApiClient({ allowAnonymous: true });
  const user = await apiClient.post('/users/authenticate', { email, password }) as User | null;
  if (!user) return null;
  await createUiSession(user.id);
  return user;
}

export async function getThisUser(): Promise<User | null> {
  try {
    const userId = await requireUiSession();
    const apiClient = new ApiClient();
    const user: User | undefined = await apiClient.get(`/users/${userId}`) as User | undefined;

    if (!user) {
      return null;
    }

    return user;
  } catch (error) {
    console.error('Error fetching user:', error);
    throw new Error('Failed to fetch user');
  }
}

export async function logoutUser(): Promise<void> {
  await clearUiSession();
}

export async function getAllUsers(): Promise<User[]> {
  try {
    const apiClient = new ApiClient();
    const users: User[] = await apiClient.get('/users') as User[];

    return users;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw new Error('Failed to fetch users');
  }
}
