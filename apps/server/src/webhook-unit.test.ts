import { EventEmitter } from 'node:events';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type { ClientRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_CONFIG,
  loadServerConfig,
  resolveWebhookConfig,
  WebhookConfigSchema,
} from './config.js';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  parseWebhookMasterKey,
} from './webhook-crypto.js';
import { classifyWebhookStatus, parseRetryAfter, webhookBackoffMs } from './webhook-dispatcher.js';
import { safeWebhookError } from './webhook-service.js';
import {
  buildWebhookHeaders,
  buildWebhookPayload,
  serializeWebhookPayload,
  verifyWebhookSignature,
  webhookSignature,
} from './webhook-payload.js';
import {
  createSafeWebhookTransport,
  isPublicIpAddress,
  parseWebhookEndpoint,
  WebhookEndpointError,
  WebhookTransportError,
  type SafeWebhookTransportOptions,
  type WebhookTransportRequest,
} from './webhook-transport.js';

const masterKey = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);

describe('webhook URL and SSRF validation', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::1',
  ])('rejects non-public literal %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public literal %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it('requires HTTPS and rejects credentials and fragments', () => {
    for (const endpoint of [
      'http://example.com/hook',
      'https://user:pass@example.com/hook',
      'https://example.com/hook#fragment',
      'not-a-url',
    ]) {
      expect(() => parseWebhookEndpoint(endpoint, false)).toThrow(WebhookEndpointError);
    }
    expect(parseWebhookEndpoint('https://example.com/hook?team=a', false).hostname).toBe(
      'example.com',
    );
  });

  it('allows private literals only with the explicit escape hatch', () => {
    expect(() => parseWebhookEndpoint('https://127.0.0.1:8443/hook', false)).toThrow();
    expect(parseWebhookEndpoint('https://127.0.0.1:8443/hook', true).url.port).toBe('8443');
  });
});

describe('webhook signing and stable allowlisted payload', () => {
  it('matches an independent HMAC-SHA256 vector over timestamp and exact bytes', () => {
    const secret = masterKey;
    const body = Buffer.from(
      '{"delivery_id":"dlv_test","event_type":"notification.created"}',
      'utf8',
    );
    expect(webhookSignature(secret, '1700000000', body)).toBe(
      'b37a64c7f543faf0c30282d1fc6f4397fb5f187e242d98084aad50ff05dc265f',
    );
    const headers = buildWebhookHeaders({
      secret,
      body,
      timestampSeconds: '1700000000',
      deliveryId: 'dlv_test',
      eventId: 'evt_test',
      attempt: 2,
    });
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-weft-timestamp': '1700000000',
      'x-weft-signature': `v1=${webhookSignature(secret, '1700000000', body)}`,
      'x-weft-delivery-id': 'dlv_test',
      'x-weft-event-id': 'evt_test',
      'x-weft-attempt': '2',
    });
    expect(webhookSignature(secret, '1700000001', body)).not.toBe(
      headers['x-weft-signature'].slice(3),
    );
    expect(
      webhookSignature(secret, '1700000000', Buffer.concat([body, Buffer.from(' ')])),
    ).not.toBe(headers['x-weft-signature'].slice(3));
  });

  it('drops raw payload/source/secret fields, redacts, and keeps stable bytes', () => {
    const secret = `ghp_${'a'.repeat(40)}`;
    const payload = buildWebhookPayload({
      deliveryId: 'dlv_stable',
      occurredAt: '2026-11-25T00:00:00.000Z',
      notificationId: 'ntf_1',
      kind: 'approval',
      title: `token ${secret}`,
      body: `subject ${secret}`,
      targetUserId: `user_${secret}`,
    }) as ReturnType<typeof buildWebhookPayload> & Record<string, unknown>;
    payload.raw = { payload: { command: 'do not forward' }, secret };
    const bytes = serializeWebhookPayload(payload);
    expect(bytes).not.toContain(secret);
    expect(safeWebhookError(new Error(`embedded user_${secret}`)).errorExcerpt).not.toContain(
      secret,
    );
    expect(bytes).not.toContain('do not forward');
    expect(bytes).not.toContain('raw');
    expect(Object.keys(JSON.parse(bytes))).toEqual([
      'delivery_id',
      'event_type',
      'occurred_at',
      'notification',
    ]);
    expect(Object.keys(JSON.parse(bytes).notification)).toEqual([
      'id',
      'kind',
      'title',
      'body',
      'target_user_id',
    ]);
    expect(serializeWebhookPayload(JSON.parse(bytes))).toBe(bytes);
  });
});

describe('webhook receiver signature verification', () => {
  it('accepts a fresh signature and rejects stale, future, malformed, or tampered requests', () => {
    const now = new Date('2026-11-25T00:00:00.000Z');
    const timestamp = '1795564800';
    const body = Buffer.from('{"notification":{"id":"ntf_1"}}', 'utf8');
    const signature = `v1=${webhookSignature(masterKey, timestamp, body)}`;
    const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
      verifyWebhookSignature({
        secret: masterKey,
        timestampSeconds: timestamp,
        body,
        signature,
        now,
        ...overrides,
      });
    expect(verify()).toBe(true);
    expect(verify({ now: new Date(now.getTime() + 300_000) })).toBe(true);
    expect(verify({ now: new Date(now.getTime() + 301_000) })).toBe(false);
    expect(verify({ now: new Date(now.getTime() - 301_000) })).toBe(false);
    expect(verify({ signature: `v1=${'0'.repeat(64)}` })).toBe(false);
    expect(verify({ signature: 'v1=abcd' })).toBe(false);
    expect(verify({ signature: signature.toUpperCase() })).toBe(false);
    expect(verify({ timestampSeconds: 'not-a-timestamp' })).toBe(false);
    expect(verify({ body: Buffer.concat([body, Buffer.from(' ')]) })).toBe(false);
    expect(verify({ secret: Buffer.alloc(32, 9) })).toBe(false);
  });
});

describe('webhook secret encryption', () => {
  it('parses hex/base64 keys and stores only authenticated ciphertext', () => {
    expect(parseWebhookMasterKey(masterKey.toString('hex'))).toEqual(masterKey);
    expect(parseWebhookMasterKey(masterKey.toString('base64'))).toEqual(masterKey);
    expect(() => parseWebhookMasterKey('too-short')).toThrow(/32-byte/);
    const secret = generateWebhookSecret();
    const encrypted = encryptWebhookSecret(masterKey, 'whk_1', 'proj_1', 1, secret);
    expect(encrypted.toString('base64')).not.toContain(secret);
    expect(decryptWebhookSecret(masterKey, 'whk_1', 'proj_1', 1, encrypted).toString()).toBe(
      secret,
    );
    expect(() => decryptWebhookSecret(masterKey, 'whk_2', 'proj_1', 1, encrypted)).toThrow(
      /authentication/,
    );
    expect(() => decryptWebhookSecret(masterKey, 'whk_1', 'proj_2', 1, encrypted)).toThrow(
      /authentication/,
    );
    expect(() => decryptWebhookSecret(masterKey, 'whk_1', 'proj_1', 2, encrypted)).toThrow(
      /authentication/,
    );
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    expect(() => decryptWebhookSecret(masterKey, 'whk_1', 'proj_1', 1, tampered)).toThrow(
      /authentication/,
    );
  });
});

describe('webhook retry policy', () => {
  it('uses deterministic bounded full jitter', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const first = webhookBackoffMs('dlv_1', attempt, 500, 30_000);
      expect(first).toBe(webhookBackoffMs('dlv_1', attempt, 500, 30_000));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(Math.min(30_000, 500 * 2 ** (attempt - 1)));
    }
  });

  it('parses Retry-After and clamps it in the dispatcher policy', () => {
    const now = new Date('2026-11-25T00:00:00.000Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Thu, 25 Nov 2026 00:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfter('nonsense', now)).toBeNull();
    expect(Math.min(30_000, parseRetryAfter('120', now) as number)).toBe(30_000);
  });

  it('classifies 2xx, retryable responses, and terminal redirects/4xx', () => {
    expect(classifyWebhookStatus(200)).toBe('succeeded');
    expect(classifyWebhookStatus(204)).toBe('succeeded');
    for (const status of [408, 429, 500, 503]) expect(classifyWebhookStatus(status)).toBe('retry');
    for (const status of [301, 302, 400, 401, 403, 404, 422])
      expect(classifyWebhookStatus(status)).toBe('dead');
  });
});

describe('webhook configuration', () => {
  it('defaults disabled and maps nested environment values', () => {
    const config = loadServerConfig({ env: { WEFT_DATABASE_URL: 'postgres://test' } });
    expect(config.webhooks).toMatchObject({ enabled: false, allowPrivateEndpoints: false });
    const enabled = loadServerConfig({
      env: {
        WEFT_DATABASE_URL: 'postgres://test',
        WEFT_SERVER_WEBHOOKS_ENABLED: 'true',
        WEFT_SERVER_WEBHOOK_MASTER_KEY: masterKey.toString('hex'),
        WEFT_SERVER_WEBHOOK_CONCURRENCY: '7',
      },
    });
    expect(enabled.webhooks).toMatchObject({ enabled: true, concurrency: 7 });
    expect(DEFAULT_WEBHOOK_CONFIG).not.toHaveProperty('masterKey');
    expect(DEFAULT_WEBHOOK_CONFIG.enabled).toBe(false);
  });

  it('accepts the master key only from the environment, not a config file', () => {
    expect(() =>
      loadServerConfig({
        file: {
          databaseUrl: 'postgres://test',
          webhooks: { enabled: true, masterKey: masterKey.toString('hex') },
        },
        env: {},
      }),
    ).toThrow(/WEFT_SERVER_WEBHOOK_MASTER_KEY/);
    const config = loadServerConfig({
      file: {
        databaseUrl: 'postgres://test',
        webhooks: { enabled: true, masterKey: 'ignored-file-key' },
      },
      env: {
        WEFT_SERVER_WEBHOOK_MASTER_KEY: masterKey.toString('hex'),
      },
    });
    expect(config.webhooks.masterKey).toBe(masterKey.toString('hex'));
  });

  it('fails clearly when enabled without a valid master key', () => {
    expect(() =>
      resolveWebhookConfig({
        dataDir: '.',
        host: '127.0.0.1',
        port: 1,
        databaseUrl: 'postgres://test',
        logLevel: 'fatal',
        corsOrigin: '*',
        webhooks: { enabled: true },
      }),
    ).toThrow(/WEFT_SERVER_WEBHOOK_MASTER_KEY/);
    expect(() =>
      resolveWebhookConfig({
        dataDir: '.',
        host: '127.0.0.1',
        port: 1,
        databaseUrl: 'postgres://test',
        logLevel: 'fatal',
        corsOrigin: '*',
        webhooks: { enabled: true, masterKey: 'bad' },
      }),
    ).toThrow(/32-byte/);
    expect(WebhookConfigSchema.parse({}).enabled).toBe(false);
  });
});

function fakeClientRequest(): {
  request: ClientRequest;
  ended: () => Buffer | undefined;
  destroyed: () => boolean;
} {
  let body: Buffer | undefined;
  let didDestroy = false;
  const request = Object.assign(new EventEmitter(), {
    destroy: () => {
      didDestroy = true;
      return request;
    },
    end: (value: Buffer) => {
      body = value;
      return request;
    },
  }) as unknown as ClientRequest;
  return { request, ended: () => body, destroyed: () => didDestroy };
}

function transportRequest(
  overrides: Partial<WebhookTransportRequest> = {},
): WebhookTransportRequest {
  return {
    endpoint: 'https://example.com/hook',
    body: Buffer.from('{"ok":true}', 'utf8'),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 1000,
    responseCapBytes: 1024,
    ...overrides,
  };
}

describe('safe HTTPS webhook transport', () => {
  it('uses the request seam and pins every validated DNS address for autoSelectFamily', async () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:4700:4700::1111', family: 6 as const },
    ];
    const fake = fakeClientRequest();
    let pinnedAll: unknown;
    let pinnedSingle: unknown;
    let requestOptions: RequestOptions | undefined;
    const requestImpl = ((
      _url: unknown,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      requestOptions = options;
      const lookup = options.lookup as unknown as (
        name: string,
        lookupOptions: { all?: boolean; family?: number },
        done: (error: Error | null, address: unknown, family?: number) => void,
      ) => void;
      lookup('example.com', { all: true }, (error, address) => {
        pinnedAll = { error, address };
      });
      lookup('example.com', { family: 6 }, (error, address, family) => {
        pinnedSingle = { error, address, family };
      });
      const response = Object.assign(new EventEmitter(), {
        statusCode: 202,
        headers: { 'retry-after': '2' },
        destroy: () => {},
      }) as unknown as IncomingMessage;
      queueMicrotask(() => {
        callback(response);
        response.emit('end');
      });
      return fake.request;
    }) as unknown as NonNullable<SafeWebhookTransportOptions['requestImpl']>;
    const transport = createSafeWebhookTransport({
      allowPrivateEndpoints: false,
      timeoutMs: 1000,
      responseCapBytes: 1024,
      lookupImpl: (async () => addresses) as unknown as SafeWebhookTransportOptions['lookupImpl'],
      requestImpl,
    });
    await expect(transport.send(transportRequest())).resolves.toEqual({
      status: 202,
      retryAfter: '2',
    });
    expect(fake.ended()).toEqual(transportRequest().body);
    expect(requestOptions).toMatchObject({ method: 'POST', servername: 'example.com' });
    expect(pinnedAll).toEqual({ error: null, address: addresses });
    expect(pinnedSingle).toEqual({ error: null, address: addresses[1]?.address, family: 6 });
  });

  it('rejects a mixed public/private DNS answer before making a request', async () => {
    let calls = 0;
    const transport = createSafeWebhookTransport({
      allowPrivateEndpoints: false,
      timeoutMs: 1000,
      responseCapBytes: 1024,
      lookupImpl: (async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]) as unknown as SafeWebhookTransportOptions['lookupImpl'],
      requestImpl: (() => {
        calls++;
        throw new Error('must not connect');
      }) as unknown as NonNullable<SafeWebhookTransportOptions['requestImpl']>,
    });
    await expect(transport.send(transportRequest())).rejects.toBeInstanceOf(WebhookEndpointError);
    expect(calls).toBe(0);
  });

  it('destroys an oversized response without unbounded buffering', async () => {
    const fake = fakeClientRequest();
    let destroyed = false;
    const requestImpl = ((
      _url: unknown,
      _options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 429,
        headers: { 'retry-after': '1' },
        destroy: () => {
          destroyed = true;
        },
      }) as unknown as IncomingMessage;
      queueMicrotask(() => {
        callback(response);
        response.emit('data', Buffer.alloc(9));
        response.emit('data', Buffer.alloc(9));
      });
      return fake.request;
    }) as unknown as NonNullable<SafeWebhookTransportOptions['requestImpl']>;
    const transport = createSafeWebhookTransport({
      allowPrivateEndpoints: false,
      timeoutMs: 1000,
      responseCapBytes: 8,
      requestImpl,
    });
    await expect(
      transport.send(
        transportRequest({
          endpoint: 'https://93.184.216.34/hook',
          responseCapBytes: 8,
        }),
      ),
    ).resolves.toEqual({ status: 429, retryAfter: '1' });
    expect(destroyed).toBe(true);
  });

  it('destroys a timed-out request and returns a retryable timeout error', async () => {
    const fake = fakeClientRequest();
    const transport = createSafeWebhookTransport({
      allowPrivateEndpoints: false,
      timeoutMs: 50,
      responseCapBytes: 1024,
      requestImpl: (() => fake.request) as unknown as NonNullable<
        SafeWebhookTransportOptions['requestImpl']
      >,
    });
    const failure = await transport
      .send(
        transportRequest({
          endpoint: 'https://93.184.216.34/hook',
          timeoutMs: 20,
        }),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebhookTransportError);
    expect(failure).toMatchObject({ errorClass: 'timeout' });
    expect(fake.destroyed()).toBe(true);
  });
});
