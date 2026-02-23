declare const __VERSION__: string | undefined;

/** Package version — injected by esbuild at build time, falls back to package.json in dev/test. */
export const VERSION: string = typeof __VERSION__ !== "undefined"
  ? __VERSION__
  : "0.1.0";
