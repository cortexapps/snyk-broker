import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';

// CVE-2026-111497 ("Node2Shell") is an out-of-bounds write in the brotli
// decoder bundled into the Node runtime, reachable by decompressing
// attacker-controlled brotli data. The broker client never needs to decode
// brotli: it strips accept-encoding/content-encoding before relaying and
// passes response bytes through untouched. So in client mode every entry into
// the decoder is replaced with one that fails, and the vulnerable code cannot
// be reached even on a runtime that still ships it.
//
// This is defense in depth, not a substitute for a patched Node (22.23.4,
// 24.22.1, 26.12.1): scanners flag the runtime by version regardless.
//
// Client only. The server's axios call to the dispatcher advertises br and
// may legitimately receive it.

export class BrotliDecodingDisabledError extends Error {
  readonly code = 'ERR_BROKER_BROTLI_DISABLED';

  constructor(api: string) {
    super(
      `${api}: brotli decoding is disabled in the broker client (CVE-2026-111497)`,
    );
    this.name = 'BrotliDecodingDisabledError';
  }
}

const isBrotliFormat = (format: unknown) =>
  typeof format === 'string' && /^(br|brotli)$/i.test(format);

let restore: (() => void) | undefined;

// zlib's create* exports are non-writable (but configurable), so plain
// assignment throws; redefine them with their original attributes instead.
const replace = (obj: object, key: string, value: unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { ...descriptor, value });
};

// The streaming entry points hand back a stream that fails on its first input
// (or at end, if there is none), asynchronously, exactly as a real decoder fed
// a corrupt body does. Each other shape breaks fetch(), which builds the
// decoder inside a response callback and pipes the body into it:
//   - throwing escapes fetch's error handling and crashes the process (Node 24);
//   - failing before fetch has wired the stream up, or synchronously inside
//     the first write, never reaches fetch, and the request hangs.
const failedStream = (api: string) =>
  new Transform({
    transform(_chunk, _encoding, callback) {
      setImmediate(callback, new BrotliDecodingDisabledError(api));
    },
    flush(callback) {
      setImmediate(callback, new BrotliDecodingDisabledError(api));
    },
  });

/**
 * Makes every brotli decode entry point in this process fail. Idempotent.
 * Returns a function that undoes it, for tests.
 */
export const disableBrotliDecoding = (): (() => void) => {
  if (restore) {
    return restore;
  }

  const z = zlib as any;
  const original = {
    createBrotliDecompress: z.createBrotliDecompress,
    brotliDecompress: z.brotliDecompress,
    brotliDecompressSync: z.brotliDecompressSync,
    BrotliDecompress: z.BrotliDecompress,
    DecompressionStream: (globalThis as any).DecompressionStream,
    binding: (process as any).binding,
  };

  replace(z, 'createBrotliDecompress', () =>
    failedStream('zlib.createBrotliDecompress'),
  );
  replace(z, 'brotliDecompressSync', () => {
    throw new BrotliDecodingDisabledError('zlib.brotliDecompressSync');
  });
  // Callback API: report through the callback, like any other decode error,
  // so util.promisify(zlib.brotliDecompress) rejects instead of throwing.
  replace(z, 'brotliDecompress', (_buf, optsOrCb, maybeCb) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const err = new BrotliDecodingDisabledError('zlib.brotliDecompress');
    if (typeof cb !== 'function') {
      throw err;
    }
    process.nextTick(cb, err);
  });
  // Returning an object from a constructor makes `new` yield it.
  replace(z, 'BrotliDecompress', function BrotliDecompress() {
    return failedStream('zlib.BrotliDecompress');
  });

  // Web streams: newer runtimes accept a brotli format.
  if (original.DecompressionStream) {
    const Original = original.DecompressionStream;
    (globalThis as any).DecompressionStream = class extends Original {
      constructor(format: string) {
        if (isBrotliFormat(format)) {
          throw new BrotliDecodingDisabledError('DecompressionStream');
        }
        super(format);
      }
    };
  }

  // The legacy native binding is still reachable via process.binding('zlib').
  if (typeof original.binding === 'function') {
    (process as any).binding = function (name: string) {
      const binding = original.binding.call(process, name);
      if (name !== 'zlib' || !binding?.BrotliDecoder) {
        return binding;
      }
      return {
        ...binding,
        BrotliDecoder: function BrotliDecoder() {
          throw new BrotliDecodingDisabledError("process.binding('zlib')");
        },
      };
    };
  }

  // ESM `import { createBrotliDecompress } from 'node:zlib'` reads a snapshot
  // of the builtin's exports; this pushes the replacements into it.
  syncBuiltinESMExports();

  restore = () => {
    replace(z, 'createBrotliDecompress', original.createBrotliDecompress);
    replace(z, 'brotliDecompress', original.brotliDecompress);
    replace(z, 'brotliDecompressSync', original.brotliDecompressSync);
    replace(z, 'BrotliDecompress', original.BrotliDecompress);
    if (original.DecompressionStream) {
      (globalThis as any).DecompressionStream = original.DecompressionStream;
    }
    (process as any).binding = original.binding;
    syncBuiltinESMExports();
    restore = undefined;
  };
  return restore;
};
