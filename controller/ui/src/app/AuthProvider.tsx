'use client';

import { ReactNode, createContext, useContext, useState, useEffect } from 'react';
import { User } from './lib/types';
import { getThisUser, getUser, logoutUser } from './server-actions/getUsers';

type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  login: () => Promise.resolve(false),
  logout: () => Promise.resolve(),
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize on component mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const user = await getThisUser();
        setUser(user);
      } catch (error) {
        console.error('Failed to restore authenticated session', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);

  // Login function - save to localStorage and update state
  const login = async (email: string, password: string): Promise<boolean> => {
    console.log('login function called');
    setIsLoading(true);
    try {
      const userData = await getUser(email, password);
      if (userData) {
        setUser(userData);
        console.log('returning true');
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to login', error);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  // Logout function - remove from localStorage and update state
  const logout = async () => {
    await logoutUser();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Hook to use the auth context
export function useAuth() {
  return useContext(AuthContext);
}
