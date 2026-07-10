'use client';

import { ReactNode, createContext, useContext, useState, useEffect } from 'react';
import { User } from './lib/types';
import { getThisUser, getUser } from './server-actions/getUsers';

type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  login: () => Promise.resolve(false),
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize on component mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const storedUserId = localStorage.getItem('userid');
        if (storedUserId) {
          const user = await getThisUser(storedUserId);
          setUser(user);
        }
      } catch (error) {
        console.error('Failed to parse user from localStorage', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);

  // Login function - save to localStorage and update state
  const login = async (email: string, password: string): Promise<boolean> => {
    console.log('login function called');
    const userData = await getUser(email, password);
    let toReturn: boolean = false;

    try {
      if (userData) {
        localStorage.setItem('userid', userData.id);
        setUser(userData);
        setIsLoading(false);
        console.log('returning true');
        toReturn = true;
      }
    } catch (error) {
      console.error('Failed to login', error);
    } finally {
      setIsLoading(false);
      console.log('returning false');
      return toReturn;
    }
  };

  // Logout function - remove from localStorage and update state
  const logout = () => {
    localStorage.removeItem('userid');
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