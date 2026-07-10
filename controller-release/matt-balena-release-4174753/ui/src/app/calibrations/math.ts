interface Point {
  x: number;
  y: number;
}

// Matrix type for clarity
type Matrix = number[][];

// Main function to find best-fit polynomial coefficients
export function findBestFitPolynomial(points: Point[], degree: number): number[] {
  if (points.length < 4) {
    throw new Error("At least 4 points are required");
  }
  if (degree < 0 || degree > 5 || degree >= points.length) {
    throw new Error("Degree must be between 0 and min(5, points.length - 1)");
  }

  // Extract x and y values
  const xValues = points.map(p => p.x);
  const yValues = points.map(p => p.y);

  // Check for duplicate x-values (can cause ill-conditioned matrix)
  const uniqueX = new Set(xValues);
  if (uniqueX.size < xValues.length) {
    console.warn("Duplicate x-values may lead to unstable results");
  }

  // Create Vandermonde matrix: X[i][j] = x_i^j
  const X: Matrix = points.map(p => {
    const row: number[] = [];
    for (let j = 0; j <= degree; j++) {
      row.push(Math.pow(p.x, j));
    }
    return row;
  });

  // Compute X^T
  const XT = transposeMatrix(X);

  // Compute X^T * X
  const XTX = multiplyMatrices(XT, X);

  // Compute X^T * y
  const XTy = multiplyMatrixVector(XT, yValues);

  // Solve (X^T * X)a = X^T * y for coefficients 'a' using Gaussian elimination
  const coefficients = solveLinearSystem(XTX, XTy);

  return coefficients;
}

// Matrix transpose
export function transposeMatrix(matrix: Matrix): Matrix {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result: Matrix = Array(cols)
    .fill(0)
    .map(() => Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = matrix[i][j];
    }
  }
  return result;
}

// Matrix multiplication
export function multiplyMatrices(A: Matrix, B: Matrix): Matrix {
  const rowsA = A.length;
  const colsA = A[0].length;
  const rowsB = B.length;
  const colsB = B[0].length;
  if (colsA !== rowsB) {
    throw new Error("Matrix dimensions incompatible for multiplication");
  }
  const result: Matrix = Array(rowsA)
    .fill(0)
    .map(() => Array(colsB).fill(0));
  for (let i = 0; i < rowsA; i++) {
    for (let j = 0; j < colsB; j++) {
      for (let k = 0; k < colsA; k++) {
        result[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return result;
}

// Matrix-vector multiplication
export function multiplyMatrixVector(matrix: Matrix, vector: number[]): number[] {
  const rows = matrix.length;
  const cols = matrix[0].length;
  if (cols !== vector.length) {
    throw new Error("Matrix and vector dimensions incompatible");
  }
  const result: number[] = Array(rows).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[i] += matrix[i][j] * vector[j];
    }
  }
  return result;
}

// Solve linear system Ax = b using Gaussian elimination
export function solveLinearSystem(A: Matrix, b: number[]): number[] {
  const n = A.length;
  const augmented: Matrix = A.map((row, i) => [...row, b[i]]);

  // Forward elimination
  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }
    // Swap rows
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    // Check for singular matrix
    if (Math.abs(augmented[i][i]) < 1e-10) {
      throw new Error("Matrix is singular or nearly singular");
    }

    // Eliminate column
    for (let k = i + 1; k < n; k++) {
      const factor = augmented[k][i] / augmented[i][i];
      for (let j = i; j <= n; j++) {
        augmented[k][j] -= factor * augmented[i][j];
      }
    }
  }

  // Back substitution
  const x: number[] = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = augmented[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= augmented[i][j] * x[j];
    }
    x[i] = sum / augmented[i][i];
  }

  return x;
}

// Evaluate polynomial at x given coefficients
export function evaluatePolynomial(coefficients: number[], x: number): number {
  let result = 0;
  for (let i = 0; i < coefficients.length; i++) {
    result += coefficients[i] * Math.pow(x, i);
  }
  return result;
}

// // Example usage
// try {
//   const points: Point[] = [
//     { x: 0, y: 1 },
//     { x: 1, y: 2 },
//     { x: 2, y: 5 },
//     { x: 3, y: 10 },
//     { x: 4, y: 17 },
//     { x: 5, y: 26 },
//   ];
//   const degree = 2; // Quadratic fit
//   const coefficients = findBestFitPolynomial(points, degree);
//   console.log("Polynomial coefficients (a_0 + a_1*x + a_2*x^2 + ...):", coefficients);

//   // Test the polynomial
//   points.forEach(p => {
//     const yFit = evaluatePolynomial(coefficients, p.x);
//     console.log(`x: ${p.x}, y_actual: ${p.y}, y_fit: ${yFit}`);
//   });
// } catch (error) {
//   console.log(error)
// }