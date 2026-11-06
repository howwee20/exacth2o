module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^rpio$': '<rootDir>/src/controllers/mocks/rpio.js' },
  testMatch: ['<rootDir>/src/tests/**/*.test.ts'],
}
