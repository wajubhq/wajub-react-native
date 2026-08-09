/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/src/test/reactNativeMock.ts',
    '^@stripe/stripe-react-native$': '<rootDir>/src/test/stripeReactNativeMock.ts',
  },
};
