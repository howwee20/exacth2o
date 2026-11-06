'use client'

import { useAuth } from './AuthProvider';
import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const { logout } = useAuth();

  return (
    <button
      className="border rounded-xl p-2 bg-red-50 text-red-600 hover:bg-red-100"
      onClick={() => logout()}
    >
      Logout
    </button>
  )
}

export function DashboardButton() {
  const router = useRouter();
  return (
    <button
      className="border rounded-xl p-2 mt-2 ml-2 bg-blue-50 text-blue-600 hover:bg-blue-100"
      onClick={() => {
        router.push('/dashboard')
      }}
    >
      Home
    </button>
  )
}

export function CalibrationsButton() {
  const router = useRouter();
  return (
    <button
      className="border rounded-xl p-2 mt-2 ml-2 bg-blue-50 text-blue-600 hover:bg-blue-100"
      onClick={() => router.push('/calibrations')}
    >
      Calibration
    </button>
  )
}