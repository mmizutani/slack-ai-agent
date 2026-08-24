/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // e2e/ holds the live-Slack harness. Only its *.test.ts files match
  // testMatch, so the pure harness logic is covered by normal CI while the
  // live cycle modules (plain .ts) are never run by Jest — the offline
  // guard would block them anyway.
  roots: ["<rootDir>/src", "<rootDir>/config", "<rootDir>/e2e"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  setupFiles: ["<rootDir>/src/test-setup.ts"],
  // Under TypeScript 6, ts-jest no longer auto-includes @types/jest for this
  // project, so every test failed with "Cannot find name 'it'". Point ts-jest
  // at a test tsconfig that lists the jest/node ambient types explicitly.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // Thread workspaces under /tmp/slack-ai-agent/workspaces/ are shared across
  // workers; run serially for determinism.
  maxWorkers: 1,
};
