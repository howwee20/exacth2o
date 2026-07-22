'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'
import { User } from '@/app/lib/types'

export async function createUser(
  userData: {
    username: string;
    email: string;
    password: string;
    firstname: string;
    lastname: string;
    isAdmin: boolean;
    isActive: boolean;
    adminPassword: string;
  }
): Promise<User | null> {
  try {
    const apiClient = new ApiClient({ allowAnonymous: true });
    const user = await apiClient.post('/users', userData) as User;
    return user;
  } catch (error) {
    console.error('Error creating user:', error);
    throw new Error('Failed to create user');
  }
}
