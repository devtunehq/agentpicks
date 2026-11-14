/**
 * ABOUTME: Types the native advisory lock agentpicks takes on its saved login.
 */
declare module 'fs-native-extensions' {
  export function tryLock(fd: number): boolean;
}
