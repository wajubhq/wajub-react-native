/**
 * `unit`: the SDK's logic, in node, with a small `react-native` stand-in.
 * `ui`: the payment sheet, with React Native's own jest preset and React
 * Native Testing Library. Both fake the HTTP layer with the spec's fixtures.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/src'],
      testMatch: ['**/__tests__/**/*.test.ts'],
      moduleNameMapper: {
        '^react-native$': '<rootDir>/src/test/reactNativeMock.ts',
        '^@stripe/stripe-react-native$': '<rootDir>/src/test/stripeReactNativeMock.ts',
        '^pusher-js$': '<rootDir>/src/test/pusherMock.ts',
      },
    },
    {
      displayName: 'ui',
      preset: 'react-native',
      roots: ['<rootDir>/src'],
      testMatch: ['**/__tests__/**/*.test.tsx'],
      moduleNameMapper: {
        '^@stripe/stripe-react-native$': '<rootDir>/src/test/stripeReactNativeMock.ts',
        '^pusher-js$': '<rootDir>/src/test/pusherMock.ts',
      },
    },
  ],
};
