/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  // Frontend source uses native-ESM-style relative imports with an explicit
  // `.js` extension (e.g. `from '../apiClient.js'`), per tsconfig.frontend.json's
  // "module": "ES2020". ts-jest compiles everything to CommonJS for the test
  // run, so this strips the extension back off before Node's CommonJS
  // resolver looks the module up.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
};
