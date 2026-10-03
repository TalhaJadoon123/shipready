import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Scans read real files from temp directories. Under heavy parallel load
    // the disk work serialises anyway, and a short timeout here produced
    // flakes rather than fast failures.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // `forks` rather than `threads`: several tests write to shared temp
    // directories, and worker threads share a process-level environment.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false, maxForks: 4 },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
