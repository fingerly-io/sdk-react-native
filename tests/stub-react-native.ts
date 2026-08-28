/**
 * A stand-in for `react-native` under vitest.
 *
 * The package is a peer dependency and is not installed in this workspace —
 * pulling the whole React Native tree in to run four unit tests would be a
 * hundred megabytes of install to test a bridge that is thirty lines. This is
 * the two objects the SDK actually touches, and `vitest.config.ts` aliases the
 * import onto it.
 *
 * Both are mutable so a test can arrange the case it wants: a module that is
 * missing, a module that rejects, an app running on Android rather than iOS.
 */

export const NativeModules: Record<string, unknown> = {}

export const Platform: { OS: 'ios' | 'android' } = { OS: 'ios' }
