/**
 * HTTP client using Node's built-in https module.
 *
 * Node's fetch (undici) has a distinctive TLS fingerprint that CloudFront WAFs
 * detect and block. Using the https module with Chrome-like cipher ordering
 * avoids this.
 */

import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { URL } from 'node:url';

// Chrome-like cipher suite ordering to avoid TLS fingerprint blocking
const CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

// Match robin_stocks session headers exactly
const DEFAULT_HEADERS: Record<string, string> = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip,deflate,br',
  'Accept-Language': 'en-US,en;q=1',
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
  'X-Robinhood-API-Version': '1.431.4',
  'Connection': 'keep-alive',
  'User-Agent': '*',
};

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const method = options.method ?? 'GET';

    const mergedHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...options.headers,
    };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: mergedHeaders,
        ciphers: CIPHERS,
        minVersion: 'TLSv1.2',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];

          const decode = (): Promise<string> => {
            return new Promise((res2, rej2) => {
              if (encoding === 'gzip') {
                zlib.gunzip(raw, (err, result) => err ? rej2(err) : res2(result.toString()));
              } else if (encoding === 'deflate') {
                zlib.inflate(raw, (err, result) => err ? rej2(err) : res2(result.toString()));
              } else if (encoding === 'br') {
                zlib.brotliDecompress(raw, (err, result) => err ? rej2(err) : res2(result.toString()));
              } else {
                res2(raw.toString());
              }
            });
          };

          let cachedText: string | null = null;

          const response: HttpResponse = {
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: Object.fromEntries(
              Object.entries(res.headers)
                .filter((e): e is [string, string] => typeof e[1] === 'string')
            ),
            async text() {
              if (cachedText === null) cachedText = await decode();
              return cachedText;
            },
            async json() {
              const t = await response.text();
              return JSON.parse(t);
            },
          };

          resolve(response);
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
