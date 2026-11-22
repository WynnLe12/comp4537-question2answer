// Mutation testing: Stryker makes many small changes to the source (a > becomes >=, a + becomes -, a condition
// becomes true, a statement is removed...), one at a time, and runs the in-process tests against each. A
// change the tests catch is "killed"; one they still pass with "survived", and points at behaviour no test
// checks. docs/mutation-testing.md explains how to read the report.
//
//   npm run test:mutation                                  (every file under src/, a few minutes)
//   npx stryker run --mutate src/q2a/points.js             (one file)
//
// Only the in-process tests (tests/integration) run here: Stryker swaps the code inside its own sandbox, and
// the parity and reliability suites talk to the API container instead, which never sees those changes. The
// parity suites are checked by scripts/mutation-canaries.sh, which plants bugs in the container itself.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'jest',
  jest: {
    configFile: 'package.json',
    config: { testPathIgnorePatterns: ['/node_modules/', '/tests/parity/', '/tests/reliability/'] },
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/**/*.js',
    '!src/server.js', // only starts the listener
    '!src/db.js',     // only builds the connection pool
  ],
  ignorePatterns: ['test-results', 'reports', 'public'],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 60, break: null },
  concurrency: 4,
  timeoutMS: 10000,
  tempDirName: '.stryker-tmp',
};
