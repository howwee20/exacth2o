'use client';

import { ReactNode, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { useRouter } from 'next/navigation';
import { SpinningLoader } from './lib/SpinningLoader';

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Only redirect if we're done loading and there's no user
    if (!isLoading && !user) {
      console.log('No user found, redirecting to login');
      router.push('/login');
    }
  }, [user, isLoading, router]);

  // Add console logs for debugging
  // console.log('Protected Layout - isLoading:', isLoading, 'user:', user);

  // Show loading state while checking authentication
  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <SpinningLoader svgClassName='w-12 h-12' />
      </div>
    );
  }

  // If there's a user, render the children (protected content)
  return user ? <>{children}</> : null;
}