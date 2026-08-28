import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // React Native is a peer dependency and is not installed here. See the
      // note in the stub for why it is aliased rather than installed.
      'react-native': new URL('./tests/stub-react-native.ts', import.meta.url).pathname,
    },
  },
})
