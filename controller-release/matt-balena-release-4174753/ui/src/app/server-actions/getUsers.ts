'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'
import { User } from '@/app/lib/types';

export async function getUser(email: string, password: string): Promise<User | null> {
  const apiClient = new ApiClient();
  const user: User | null = await apiClient.get(`/users/email/${encodeURIComponent(email)}`) as User | null;

  if (user) {
    if (user.password === password) {
      return user;
    }
  }
  return null;
}

export async function getThisUser(userId?: string): Promise<User | null> {
  try {
    if (!userId) {
      return null;
    }

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