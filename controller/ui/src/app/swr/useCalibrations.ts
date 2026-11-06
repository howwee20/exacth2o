'use client'

import useSWR from "swr"
import { getCalibrations } from '../server-actions/calibrationsCRUD'

export interface Calibration {
  id: number;
  name: string;
  polynomialCoefficientsCommaDelimited: string;
  readingsJSONString: string;
  createdAt: string;
  updatedAt: string;
}

export const useCalibrations = (): {
  calibrations: Calibration[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Calibration[] | Promise<Calibration[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'calibrations',
    async () => {
      const data = await getCalibrations();
      return data;
    },
    // { refreshInterval: 15000 }
  )

  return {
    calibrations: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}

// Helper function to display polynomial as a readable function
export const formatPolynomialFunction = (coefficientsString: string): string => {
  try {
    const coefficients = coefficientsString.split(',').map(Number);

    if (coefficients.length === 0) return 'Invalid polynomial';

    let formula = 'f(x) = ';

    coefficients.forEach((coeff, index) => {
      // Skip zero coefficients except for the constant term
      if (coeff === 0 && (index !== 0 || coefficients.length === 1)) return;

      // Add sign for terms after the first one
      if (index > 0 && coeff > 0 && formula !== 'f(x) = ') {
        formula += ' + ';
      } else if (index > 0 && coeff < 0) {
        formula += ' - ';
        coeff = Math.abs(coeff); // Make coefficient positive since we added the minus sign
      }

      // Format the coefficient (except 1 for non-constant terms)
      if (index === 0) {
        formula += coeff;
      } else if (index === 1) {
        formula += (coeff === 1 ? '' : coeff) + 'x';
      } else {
        formula += (coeff === 1 ? '' : coeff) + 'x^' + index;
      }
    });

    return formula;
  } catch (error) {
    console.error('Error formatting polynomial:', error);
    return 'Invalid polynomial format';
  }
}