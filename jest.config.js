module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  // Cloned third-party repos used by the token benchmark carry their own tests.
  testPathIgnorePatterns: ['/node_modules/', '/benchmarks/\\.fixtures/'],
  modulePathIgnorePatterns: ['<rootDir>/benchmarks/\\.fixtures/'],
};