/**
 * Minimal types for lzma-purejs.
 *
 * The package ships no declarations and is CommonJS, but this project compiles to ESM, so the
 * module is declared with a default export and imported that way. Only `decompressFile` is
 * called; typing the rest would be inventing an API surface we never use.
 */
declare module "lzma-purejs" {
  interface Lzma {
    decompressFile(input: Uint8Array | number[]): Uint8Array;
    compressFile(input: Uint8Array | number[]): Uint8Array;
  }
  const lzma: Lzma;
  export default lzma;
}
