'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../AuthProvider';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [validationErrors, setValidationErrors] = useState<{
    email?: string;
    password?: string;
  }>({});

  const router = useRouter();
  const { login } = useAuth();

  const validateForm = () => {
    const errors: { email?: string; password?: string } = {};

    if (!email) {
      errors.email = 'Email is required';
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = 'Email is invalid';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 6) {
      errors.password = 'Password must be at least 6 characters';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setIsLoading(true);
    setError('');

    const success = await login(email, password);
    // TODO: slight bug here somewhere
    if (success) {
      router.push('/dashboard');
    } else {
      setError('Invalid email or password');
      setIsLoading(false);
    }
  };

  const handleCreateUser = () => {
    router.push('/register');
  };

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50">
      <div className="w-full max-w-md p-8 space-y-6 bg-white rounded-lg shadow-lg">
        <div>
          <h1 className="text-2xl font-bold text-center">Walker Labs</h1>
          <h2 className="text-xl font-bold text-center mt-2">Master Control</h2>
          <p className="text-sm text-gray-500 text-center mt-2">Sign in to your account</p>
        </div>

        {error && (
          <div className="p-4 bg-red-50 rounded-lg border border-red-200">
            <p className="text-red-600">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="text-md font-semibold mb-3">Login Information</h3>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`mt-1 block w-full rounded-md ${validationErrors.email ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="Enter your email"
              />
              {validationErrors.email && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.email}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`mt-1 block w-full rounded-md ${validationErrors.password ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="Enter your password"
              />
              {validationErrors.password && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.password}</p>
              )}
            </div>
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={handleCreateUser}
              className="px-4 py-2 text-sm font-medium text-blue-600 bg-gray-100 rounded hover:bg-gray-200"
            >
              Create User
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
              disabled={isLoading}
            >
              {isLoading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}