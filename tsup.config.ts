import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  target: 'es2020',
  // React Native is a peer dependency: bundling it would give the app two
  // copies of the bridge, and `NativeModules` resolved from the wrong one is
  // `NativeModules` with nothing in it.
  external: ['react-native'],
})
