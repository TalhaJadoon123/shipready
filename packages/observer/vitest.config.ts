import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      // One fork, tests in a single child process.
      //
      // These are the heaviest tests in the repo: TraceStore opens a real
      // better-sqlite3 database per test, and `observe.test.ts` spawns actual
      // child agents and waits on them. With several forks competing, vitest's
      // worker-to-main RPC times out and reports
      // `[vitest-worker]: Timeout calling "onTaskUpdate"` -- which reads like a
      // test failure but is not one. Every test here passes when the suite is
      // given the machine to itself.
      forks: { singleFork: true },
    },
  },
});