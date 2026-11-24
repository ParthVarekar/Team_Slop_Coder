import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Redactor, redact, shannonEntropy, SECRET_RULES } from '@weft/core';

interface CorpusEntry {
  label: string;
  text: string;
  /** Exact substring that must NOT survive redaction. */
  secret: string;
}

const CORPUS: CorpusEntry[] = [
  {
    label: 'github-pat',
    text: `token: ghp_${'x'.repeat(36)} end`,
    secret: `ghp_${'x'.repeat(36)}`,
  },
  {
    label: 'github-fine-grained',
    text: `github_pat_${'a1'.repeat(40)}`,
    secret: `github_pat_${'a1'.repeat(40)}`,
  },
  { label: 'gitlab-pat', text: `glpat-${'x'.repeat(20)}`, secret: `glpat-${'x'.repeat(20)}` },
  // Runtime-built (identical values) to avoid secret-scanner false positives on these fixtures.
  {
    label: 'slack-token',
    text: `xoxb-${'123456789012'}-${'1234567890123'}-${'abcdefABCDEF1234567890ab'}`,
    secret: `xoxb-${'123456789012'}-${'1234567890123'}-${'abcdefABCDEF1234567890ab'}`,
  },
  {
    label: 'slack-webhook',
    text: `https://hooks.slack.com/services/${'T00000000'}/${'B00000000'}/${'X'.repeat(24)}`,
    secret: `https://hooks.slack.com/services/${'T00000000'}/${'B00000000'}/${'X'.repeat(24)}`,
  },
  {
    label: 'anthropic-key',
    text: `sk-ant-${'x'.repeat(30)}`,
    secret: `sk-ant-${'x'.repeat(30)}`,
  },
  { label: 'openai-key', text: `sk-${'x'.repeat(40)}`, secret: `sk-${'x'.repeat(40)}` },
  {
    label: 'openai-proj-key',
    text: `sk-proj-${'x'.repeat(40)}`,
    secret: `sk-proj-${'x'.repeat(40)}`,
  },
  { label: 'google-api-key', text: `AIza${'x'.repeat(35)}`, secret: `AIza${'x'.repeat(35)}` },
  { label: 'aws-access-key-id', text: 'AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE' },
  {
    label: 'aws-secret-access-key',
    text: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  { label: 'stripe-key', text: `sk_live_${'x'.repeat(24)}`, secret: `sk_live_${'x'.repeat(24)}` },
  { label: 'npm-token', text: `npm_${'x'.repeat(36)}`, secret: `npm_${'x'.repeat(36)}` },
  {
    label: 'sendgrid-key',
    text: `SG.${'x'.repeat(22)}.${'y'.repeat(43)}`,
    secret: `SG.${'x'.repeat(22)}.${'y'.repeat(43)}`,
  },
  { label: 'twilio-key', text: `SK${'a1b2c3d4'.repeat(4)}`, secret: `SK${'a1b2c3d4'.repeat(4)}` },
  {
    label: 'private-key',
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1t\n-----END RSA PRIVATE KEY-----',
    secret: '-----BEGIN RSA PRIVATE KEY-----',
  },
  {
    label: 'jwt',
    text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    secret:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
  {
    label: 'connection-string',
    text: 'postgres://admin:secretpass@db.internal:5432/app',
    secret: 'admin:secretpass@db.internal',
  },
  {
    label: 'bearer-token',
    text: 'Authorization: Bearer abcdef1234567890ABCDEF',
    secret: 'abcdef1234567890ABCDEF',
  },
  {
    label: 'generic-api-key',
    text: 'api_key = "abcdef1234567890abcdef"',
    secret: 'abcdef1234567890abcdef',
  },
  {
    label: 'password-assignment',
    text: 'password = "Hunter2Hunter2Hunter2"',
    secret: 'Hunter2Hunter2Hunter2',
  },
  {
    label: 'unknown-high-entropy',
    text: 'value aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA2bC4dE',
    secret: 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA2bC4dE',
  },
];

const BENIGN: string[] = [
  'The getUserById function returns a User object.',
  'Run pnpm install then pnpm test to verify the build.',
  'export const PORT = 7421;',
  'See https://example.com/docs for details.',
  "const name = 'hello world';",
  'Commit a1b2c3d updated the auth module.',
  'Modified 8 files in authentication; three functions changed.',
  'function add(a: number, b: number): number { return a + b; }',
];

describe('shannonEntropy', () => {
  it('is zero for uniform strings and higher for varied ones', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1);
    expect(shannonEntropy('aB3dE5fG7hI9jK1lM3nO5pQ7')).toBeGreaterThan(3.5);
  });
});

describe('redaction corpus — no planted secret survives', () => {
  it.each(CORPUS)('redacts $label', ({ text, secret }) => {
    const result = new Redactor().redact(text);
    expect(result.redactions.length).toBeGreaterThan(0);
    expect(result.text.includes(secret)).toBe(false);
  });

  it('redacts 100% of the corpus in one pass', () => {
    const combined = CORPUS.map((c) => c.text).join('\n');
    const result = new Redactor().redact(combined);
    for (const { secret } of CORPUS) {
      expect(result.text.includes(secret)).toBe(false);
    }
  });

  it('property: secret removed regardless of surrounding prose', () => {
    const entryArb = fc.constantFrom(...CORPUS);
    const wordArb = fc.stringMatching(/^[a-z]{3,10}$/);
    fc.assert(
      fc.property(entryArb, wordArb, wordArb, (entry, before, after) => {
        const text = `${before} ${entry.text} ${after}`;
        const out = redact(text);
        expect(out.includes(entry.secret)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe('redaction false-positive guards', () => {
  it.each(BENIGN)('leaves benign text unchanged: %s', (text) => {
    const result = new Redactor().redact(text);
    expect(result.redactions).toHaveLength(0);
    expect(result.text).toBe(text);
  });

  it('matches unfiltered rule scans for corpus and benign text', () => {
    const unfiltered = new Redactor({
      rules: SECRET_RULES.map(({ hint: _hint, ...rule }) => rule),
    });
    for (const text of [...CORPUS.map((entry) => entry.text), ...BENIGN]) {
      expect(new Redactor().redact(text)).toEqual(unfiltered.redact(text));
    }
  });

  it('matches unfiltered rule scans for generated text', () => {
    const unfiltered = new Redactor({
      rules: SECRET_RULES.map(({ hint: _hint, ...rule }) => rule),
    });
    const text = fc.oneof(
      { depth: 1 },
      fc.string(),
      fc.constantFrom(...CORPUS.map((entry) => entry.text), ...BENIGN),
    );
    fc.assert(
      fc.property(text, fc.string(), fc.string(), (value, before, after) => {
        const input = `${before}${value}${after}`;
        expect(new Redactor().redact(input)).toEqual(unfiltered.redact(input));
      }),
      { numRuns: 500 },
    );
  });

  it('does not apply the default prefilter to custom rules', () => {
    const custom = new Redactor({
      rules: [{ id: 'custom', description: 'custom marker', regex: /CUSTOM-[0-9]+/dg }],
      entropyThreshold: 0,
    });
    expect(custom.redact('value CUSTOM-123')).toEqual({
      text: 'value [REDACTED:custom]',
      redactions: [{ ruleId: 'custom', start: 6, end: 16 }],
    });
  });

  it('is idempotent', () => {
    for (const { text } of CORPUS) {
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
  });
});

describe('rule registry', () => {
  it('every rule carries global + indices flags', () => {
    for (const rule of SECRET_RULES) {
      expect(rule.regex.global, rule.id).toBe(true);
      expect(rule.regex.hasIndices, rule.id).toBe(true);
    }
  });
});
