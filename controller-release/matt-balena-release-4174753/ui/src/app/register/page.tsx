'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createUser } from '../server-actions/createUser'

export default function RegisterPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Form fields
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstname, setFirstname] = useState('')
  const [lastname, setLastname] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [adminPassword, setAdminPassword] = useState('')

  // Validation
  const [validationErrors, setValidationErrors] = useState<{
    username?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
    firstname?: string;
    lastname?: string;
    adminPassword?: string;
  }>({})

  const validateForm = () => {
    const errors: {
      username?: string;
      email?: string;
      password?: string;
      confirmPassword?: string;
      firstname?: string;
      lastname?: string;
      adminPassword?: string;
    } = {}

    if (!username) {
      errors.username = 'Username is required'
    }

    if (!email) {
      errors.email = 'Email is required'
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = 'Email is invalid'
    }

    if (!password) {
      errors.password = 'Password is required'
    } else if (password.length < 6) {
      errors.password = 'Password must be at least 6 characters'
    }

    if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match'
    }

    if (!firstname) {
      errors.firstname = 'First name is required'
    }

    if (!lastname) {
      errors.lastname = 'Last name is required'
    }

    if (!adminPassword) {
      errors.adminPassword = 'Admin password is required to create users'
    }

    setValidationErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setIsLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const user = await createUser({
        username,
        email,
        password,
        firstname,
        lastname,
        isAdmin,
        isActive,
        adminPassword
      })

      if (user) {
        setSuccess('User created successfully. You can now log in.')
        // Reset form
        setUsername('')
        setEmail('')
        setPassword('')
        setConfirmPassword('')
        setFirstname('')
        setLastname('')
        setIsAdmin(false)
        setIsActive(true)
        setAdminPassword('')
      } else {
        setError('Failed to create user')
      }
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message || 'An error occurred. Please try again.')
      } else {
        setError('An error occurred. Please try again.')
      }
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleBackToLogin = () => {
    router.push('/login')
  }

  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-50 py-10">
      <div className="w-full max-w-lg p-8 space-y-6 bg-white rounded-lg shadow-lg">
        <div>
          <h1 className="text-2xl font-bold text-center">Walker Labs</h1>
          <h2 className="text-xl font-bold text-center mt-2">Master Control</h2>
          <p className="text-sm text-gray-500 text-center mt-2">Create a new user account</p>
        </div>

        {error && (
          <div className="p-4 bg-red-50 rounded-lg border border-red-200">
            <p className="text-red-600">{error}</p>
          </div>
        )}

        {success && (
          <div className="p-4 bg-green-50 rounded-lg border border-green-200">
            <p className="text-green-600">{success}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Information */}
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="text-md font-semibold mb-3">User Information</h3>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.username ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Enter username"
                />
                {validationErrors.username && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.username}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.email ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Enter email"
                />
                {validationErrors.email && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.email}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">First Name</label>
                <input
                  type="text"
                  value={firstname}
                  onChange={(e) => setFirstname(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.firstname ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Enter first name"
                />
                {validationErrors.firstname && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.firstname}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Last Name</label>
                <input
                  type="text"
                  value={lastname}
                  onChange={(e) => setLastname(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.lastname ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Enter last name"
                />
                {validationErrors.lastname && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.lastname}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.password ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Enter password"
                />
                {validationErrors.password && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.password}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`mt-1 block w-full rounded-md ${validationErrors.confirmPassword ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                  placeholder="Confirm password"
                />
                {validationErrors.confirmPassword && (
                  <p className="mt-1 text-sm text-red-600">{validationErrors.confirmPassword}</p>
                )}
              </div>
            </div>
          </div>

          {/* User Settings */}
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="text-md font-semibold mb-3">User Settings</h3>

            <div className="flex space-x-6">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isAdmin"
                  checked={isAdmin}
                  onChange={(e) => setIsAdmin(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="isAdmin" className="ml-2 block text-sm text-gray-700">
                  Admin User
                </label>
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="isActive" className="ml-2 block text-sm text-gray-700">
                  Active User
                </label>
              </div>
            </div>
          </div>

          {/* Admin Authorization */}
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="text-md font-semibold mb-3">Admin Authorization</h3>

            <div>
              <label className="block text-sm font-medium text-gray-700">Admin Password</label>
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className={`mt-1 block w-full rounded-md ${validationErrors.adminPassword ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="Enter admin password for authorization"
              />
              {validationErrors.adminPassword && (
                <p className="mt-1 text-sm text-red-600">{validationErrors.adminPassword}</p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                Admin password is required to create users. Only existing admins can create new users.
              </p>
            </div>
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={handleBackToLogin}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            >
              Back to Login
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
              disabled={isLoading}
            >
              {isLoading ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}