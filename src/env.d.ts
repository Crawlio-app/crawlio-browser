declare const __DEV__: boolean;

// Stamped by tsup at build time. Reported by get_capabilities so a caller can tell WHICH build
// Chrome has loaded: an unpacked extension does not hot-reload, and the manifest version does
// not change between rebuilds within a release, so neither answers "is the running code the
// code I just built?".
declare const __BUILD_ID__: string;
