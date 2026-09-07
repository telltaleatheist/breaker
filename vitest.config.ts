import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Everything under test/ covers src/api and src/core, which are deliberately
    // free of chrome.* — so there is no DOM/extension environment to emulate.
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
