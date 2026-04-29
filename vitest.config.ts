import { defineConfig } from 'vitest/config'

// Vitest configuration.
//
// We only run tests against pure business-logic modules under `electron/`
// and `src/` that don't require an Electron runtime — tool-cache,
// task-state, archive, repo-map, slash commands, checkpoints, etc. Any
// file that imports 'electron' is out of scope by default (see `exclude`).
//
// Coverage uses v8 (built into Node) so no native dependencies are needed.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'dist-electron/**'],
    setupFiles: ['tests/setup-env.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'electron/tool-cache.ts',
        'electron/task-state.ts',
        'electron/archive.ts',
        'electron/repo-map.ts',
        'electron/project-rules.ts',
        'electron/checkpoints.ts',
        'src/slashCommands.ts',
      ],
    },
  },
})
