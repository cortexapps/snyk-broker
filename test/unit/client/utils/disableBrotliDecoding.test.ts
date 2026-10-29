import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  BrotliDecodingDisabledError,
  disableBrotliDecoding,
} from '../../../../lib/client/utils/disableBrotliDecoding';

const payload = Buffer.from('hello from upstream');
const brotli = zlib.brotliCompressSync(payload);
const gzip = zlib.gzipSync(payload);

describe('client/utils/disableBrotliDecoding', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = disableBrotliDecoding();
  });

  afterEach(() => {
    restore();
  });

  it('rejects every zlib brotli decode entry point', async () => {
    expect(() => zlib.brotliDecompressSync(brotli)).toThrow(
      BrotliDecodingDisabledError,
    );
    await expect(promisify(zlib.brotliDecompress)(brotli)).rejects.toThrow(
      BrotliDecodingDisabledError,
    );
  });

  // Streams fail the way a corrupt body would, through their 'error' event,
  // instead of throwing out of whatever callback created them.
  it.each([
    ['createBrotliDecompress', () => zlib.createBrotliDecompress()],
    ['BrotliDecompress', () => new (zlib as any).BrotliDecompress()],
  ])('%s returns a stream that errors', async (_name, create) => {
    const stream = create();
    stream.end(brotli);
    const [err] = await once(stream, 'error');
    expect(err).toBeInstanceOf(BrotliDecodingDisabledError);
  });

  it('rejects the legacy native binding', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding = (process as any).binding('zlib');
    expect(() => new binding.BrotliDecoder()).toThrow(
      BrotliDecodingDisabledError,
    );
  });

  it('rejects brotli DecompressionStream but keeps other formats', () => {
    for (const format of ['br', 'brotli']) {
      expect(() => new DecompressionStream(format as any)).toThrow(
        BrotliDecodingDisabledError,
      );
    }
    expect(() => new DecompressionStream('gzip')).not.toThrow();
  });

  it('leaves gzip, deflate and brotli compression working', () => {
    expect(zlib.gunzipSync(gzip)).toEqual(payload);
    expect(zlib.inflateSync(zlib.deflateSync(payload))).toEqual(payload);
    expect(zlib.brotliCompressSync(payload)).toBeInstanceOf(Buffer);
  });

  it('is idempotent', () => {
    expect(disableBrotliDecoding()).toBe(restore);
  });

  it('restores the originals', () => {
    restore();
    expect(zlib.brotliDecompressSync(brotli)).toEqual(payload);
    restore = disableBrotliDecoding();
  });

  // fetch() decodes Content-Encoding: br on its own -- the documented way an
  // attacker-controlled upstream reaches the decoder. It runs in a child
  // process: jest's sandbox gives fetch a different zlib than the test's, so
  // the guard would not be exercised in-process.
  it('fails fetch of a brotli response without crashing, keeps gzip', () => {
    const script = `
      require('ts-node').register({ transpileOnly: true });
      const http = require('node:http');
      const zlib = require('node:zlib');
      const { disableBrotliDecoding } = require(${JSON.stringify(
        path.resolve(
          __dirname,
          '../../../../lib/client/utils/disableBrotliDecoding',
        ),
      )});
      const body = Buffer.from('hello');
      const server = http.createServer((req, res) => {
        const br = req.url === '/br';
        res.writeHead(200, { 'content-encoding': br ? 'br' : 'gzip' });
        res.end(br ? zlib.brotliCompressSync(body) : zlib.gzipSync(body));
      });
      server.listen(0, async () => {
        disableBrotliDecoding();
        const url = 'http://127.0.0.1:' + server.address().port;
        try {
          await (await fetch(url + '/br')).arrayBuffer();
          console.log('br: decoded');
        } catch (e) {
          console.log('br: ' + (e.cause?.code ?? e.code ?? e.message));
        }
        const gz = await (await fetch(url + '/gzip')).text();
        console.log('gzip: ' + gz);
        // fetch keeps the connection alive, so server.close() never settles.
        process.exit(0);
      });
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out).toContain('br: ERR_BROKER_BROTLI_DISABLED');
    expect(out).toContain('gzip: hello');
  });

  describe('against a real upstream', () => {
    let server: http.Server;
    let url: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const br = req.url === '/br';
        res.writeHead(200, { 'content-encoding': br ? 'br' : 'gzip' });
        res.end(br ? brotli : gzip);
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    // The relay path: http.request never decodes, so brotli bytes pass
    // through untouched to the server, exactly as before.
    it('passes brotli bytes through http.request untouched', async () => {
      const body = await new Promise<Buffer>((resolve, reject) => {
        http
          .get(`${url}/br`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          })
          .on('error', reject);
      });
      expect(body).toEqual(brotli);
    });
  });
});
