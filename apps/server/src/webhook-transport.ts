import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction as NetLookupFunction } from 'node:net';

export interface WebhookTransportRequest {
  endpoint: string;
  body: Buffer;
  headers: Record<string, string>;
  timeoutMs: number;
  responseCapBytes: number;
}

export interface WebhookTransportResponse {
  status: number;
  retryAfter?: string | undefined;
}

export interface WebhookTransport {
  send(request: WebhookTransportRequest): Promise<WebhookTransportResponse>;
}

export interface SafeWebhookTransportOptions {
  allowPrivateEndpoints: boolean;
  timeoutMs: number;
  responseCapBytes: number;
  lookupImpl?: typeof lookup;
  /** Test seam; production always uses node:https. */
  requestImpl?: typeof httpsRequest;
}

export class WebhookEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookEndpointError';
  }
}

export class WebhookTransportError extends Error {
  constructor(
    readonly errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookTransportError';
  }
}

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseIPv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = (out << 8n) | BigInt(octet);
  }
  return out;
}

function parseIPv6(value: string): bigint | null {
  let text = value;
  if (text.includes('%')) return null;
  const dotted = text.lastIndexOf(':');
  if (dotted >= 0 && text.includes('.', dotted + 1)) {
    const v4 = parseIPv4(text.slice(dotted + 1));
    if (v4 === null) return null;
    const high = Number((v4 >> 16n) & 0xffffn).toString(16);
    const low = Number(v4 & 0xffffn).toString(16);
    text = `${text.slice(0, dotted + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = (half: string): number[] | null => {
    if (half === '') return [];
    const parts = half.split(':');
    if (parts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = words(halves[0] ?? '');
  const right = halves.length === 2 ? words(halves[1] ?? '') : [];
  if (left === null || right === null) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array<number>(missing).fill(0), ...right];
  return all.reduce((acc, word) => (acc << 16n) | BigInt(word), 0n);
}

function parseIp(value: string): ParsedIp | null {
  const version = isIP(value);
  if (version === 4) {
    const parsed = parseIPv4(value);
    return parsed === null ? null : { version, value: parsed };
  }
  if (version === 6) {
    const parsed = parseIPv6(value);
    return parsed === null ? null : { version, value: parsed };
  }
  return null;
}

function between(value: bigint, low: bigint, high: bigint): boolean {
  return value >= low && value < high;
}

/** True only for globally routable unicast addresses (conservative by default). */
export function isPublicIpAddress(value: string): boolean {
  const ip = parseIp(value);
  if (!ip) return false;
  if (ip.version === 4) {
    const v = ip.value;
    const blocked =
      v < 0x01000000n || // 0.0.0.0/8
      between(v, 0x0a000000n, 0x0b000000n) || // 10.0.0.0/8
      between(v, 0x64400000n, 0x64440000n) || // 100.64.0.0/10
      between(v, 0x7f000000n, 0x80000000n) || // 127.0.0.0/8
      between(v, 0xa9fe0000n, 0xa9ff0000n) || // 169.254.0.0/16
      between(v, 0xac100000n, 0xac200000n) || // 172.16.0.0/12
      between(v, 0xc0000000n, 0xc0000100n) || // 192.0.0.0/24
      between(v, 0xc0000200n, 0xc0000300n) || // 192.0.2.0/24
      between(v, 0xc0a80000n, 0xc0a90000n) || // 192.168.0.0/16
      between(v, 0xc6120000n, 0xc6140000n) || // 198.18.0.0/15
      between(v, 0xc6336400n, 0xc6336500n) || // 198.51.100.0/24
      between(v, 0xc6336500n, 0xc6336600n) || // 203.0.113.0/24
      v >= 0xe0000000n; // multicast + reserved
    return !blocked;
  }

  const v = ip.value;
  const high96 = v >> 32n;
  if (high96 === 0xffffn) return isPublicIpAddress(`${v & 0xffffffffn}`);
  if (high96 === 0n) return false; // unspecified, loopback, IPv4-compatible
  if (v >> 125n !== 1n) return false; // not 2000::/3 global unicast
  if (v >> 96n === 0x20010db8n) return false; // documentation
  if (v >> 80n === 0x20010002n) return false; // benchmarking
  if (v >> 96n >= 0x20010010n && v >> 96n <= 0x2001001fn) return false; // ORCHID
  if (v >> 32n === 0x20010000n) return false; // Teredo
  if (v >> 112n === 0x2002n) return false; // 6to4
  return true;
}

export function parseWebhookEndpoint(
  raw: string,
  allowPrivateEndpoints: boolean,
): { url: URL; hostname: string } {
  if (raw.length > 2048 || raw.includes('#')) {
    throw new WebhookEndpointError('webhook endpoint must be an HTTPS URL without a fragment');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookEndpointError('webhook endpoint must be a valid URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    throw new WebhookEndpointError(
      'webhook endpoint must use HTTPS and must not contain credentials',
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateEndpoints && isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new WebhookEndpointError('webhook endpoint resolves to a non-public address');
  }
  return { url, hostname };
}

function errorClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNABORTED') {
    return 'timeout';
  }
  if (typeof code === 'string' && code.startsWith('ERR_TLS')) return 'tls_error';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'EPIPE'
  ) {
    return 'network_error';
  }
  return 'network_error';
}

function transportError(error: unknown, fallback: string): WebhookTransportError {
  if (error instanceof WebhookTransportError) return error;
  return new WebhookTransportError(
    errorClass(error),
    error instanceof Error ? error.message : fallback,
  );
}

/** Default HTTPS-only transport. It validates and pins DNS before connecting. */
export function createSafeWebhookTransport(options: SafeWebhookTransportOptions): WebhookTransport {
  const resolve = options.lookupImpl ?? lookup;
  const sendRequest = options.requestImpl ?? httpsRequest;
  return {
    async send(input) {
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new WebhookTransportError('configuration', 'webhook timeout must be positive');
      }
      if (!Number.isFinite(input.responseCapBytes) || input.responseCapBytes <= 0) {
        throw new WebhookTransportError('configuration', 'webhook response cap must be positive');
      }
      // Constructor limits are hard ceilings even for an injected/custom caller.
      const timeoutMs = Math.min(input.timeoutMs, options.timeoutMs);
      const responseCapBytes = Math.min(input.responseCapBytes, options.responseCapBytes);
      const deadline = Date.now() + timeoutMs;
      const remainingMs = (): number => Math.max(1, deadline - Date.now());
      const { url, hostname } = parseWebhookEndpoint(input.endpoint, options.allowPrivateEndpoints);
      let addresses: LookupAddress[];
      const literalFamily = isIP(hostname);
      if (literalFamily !== 0) {
        if (!options.allowPrivateEndpoints && !isPublicIpAddress(hostname)) {
          throw new WebhookEndpointError('webhook endpoint resolves to a non-public address');
        }
        addresses = [{ address: hostname, family: literalFamily }];
      } else {
        let dnsTimer: NodeJS.Timeout | undefined;
        try {
          addresses = await Promise.race([
            resolve(hostname, { all: true, verbatim: true }),
            new Promise<never>((_resolve, reject) => {
              dnsTimer = setTimeout(() => {
                reject(new WebhookTransportError('timeout', 'DNS lookup timed out'));
              }, remainingMs());
              dnsTimer.unref?.();
            }),
          ]);
        } catch (error) {
          if (error instanceof WebhookTransportError) throw error;
          throw transportError(error, 'DNS lookup failed');
        } finally {
          if (dnsTimer) clearTimeout(dnsTimer);
        }
        if (addresses.length === 0) {
          throw new WebhookTransportError('dns_error', 'DNS lookup returned no addresses');
        }
        if (
          addresses.some(
            (entry) => isIP(entry.address) === 0 || isIP(entry.address) !== entry.family,
          )
        ) {
          throw new WebhookTransportError('dns_error', 'DNS lookup returned an invalid address');
        }
        if (
          !options.allowPrivateEndpoints &&
          addresses.some((a) => !isPublicIpAddress(a.address))
        ) {
          throw new WebhookEndpointError('webhook endpoint resolves to a non-public address');
        }
      }

      // Return only the validated set. A second DNS lookup can never introduce a
      // rebinding address; hostname/SNI and certificate validation stay intact.
      let pinIndex = 0;
      const pinnedLookup: NetLookupFunction = (name, lookupOptions, callback) => {
        if (name !== hostname) {
          callback(
            Object.assign(new Error('unexpected DNS hostname'), { code: 'EAI_AGAIN' }),
            '',
            0,
          );
          return;
        }
        const all = typeof lookupOptions === 'object' && lookupOptions.all === true;
        const wanted = typeof lookupOptions === 'object' ? lookupOptions.family : undefined;
        const candidates = addresses.filter((entry) =>
          wanted === 4 || wanted === 6 ? entry.family === wanted : true,
        );
        const selected = candidates[pinIndex % Math.max(1, candidates.length)];
        pinIndex++;
        if (!selected) {
          callback(
            Object.assign(new Error('address family unavailable'), { code: 'EAI_AGAIN' }),
            '',
            0,
          );
          return;
        }
        // Node's autoSelectFamily path requests { all: true }; returning a scalar
        // there breaks the real HTTPS transport even though simple mocks pass.
        if (all) callback(null, candidates);
        else callback(null, selected.address, selected.family);
      };

      return new Promise<WebhookTransportResponse>((resolveResponse, rejectResponse) => {
        let settled = false;
        let req: ReturnType<typeof sendRequest> | undefined;
        const finish = (error?: unknown, response?: WebhookTransportResponse): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined) rejectResponse(error);
          else resolveResponse(response as WebhookTransportResponse);
        };
        const requestOptions: RequestOptions = {
          method: 'POST',
          headers: input.headers,
          lookup: pinnedLookup,
          servername: isIP(hostname) === 0 ? hostname : undefined,
          maxHeaderSize: Math.max(4096, responseCapBytes),
        };
        const timer = setTimeout(() => {
          finish(new WebhookTransportError('timeout', 'webhook request timed out'));
          req?.destroy();
        }, remainingMs());
        timer.unref?.();
        try {
          req = sendRequest(url, requestOptions, (res) => {
            let bytes = 0;
            const retryAfter = res.headers['retry-after'];
            const response: WebhookTransportResponse = {
              status: res.statusCode ?? 0,
              ...(typeof retryAfter === 'string' ? { retryAfter } : {}),
            };
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > responseCapBytes) {
                res.destroy();
                finish(undefined, response);
              }
            });
            res.on('end', () => finish(undefined, response));
            res.on('error', (error) => finish(transportError(error, 'response failed')));
            res.on('aborted', () =>
              finish(new WebhookTransportError('network_error', 'response aborted')),
            );
          });
          if (settled) {
            req.destroy();
            return;
          }
          req.on('error', (error) => finish(transportError(error, 'webhook request failed')));
          req.end(input.body);
        } catch (error) {
          req?.destroy();
          finish(transportError(error, 'webhook request failed'));
        }
      });
    },
  };
}
