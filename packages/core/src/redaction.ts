import { metrics } from './metrics.js';

export interface RedactionRule {
  id: string;
  description: string;
  /** Must carry the `d` (indices) and `g` (global) flags. */
  regex: RegExp;
  /** Capture group to redact (0 = whole match). */
  group?: number;
}

const matchesTotal = metrics.counter('weft_redaction_matches_total', 'Secret spans redacted');
const charsTotal = metrics.counter('weft_redaction_chars_total', 'Characters scanned for secrets');

/**
 * Fresh, generic secret patterns inspired by the gitleaks rule taxonomy
 * (not copied verbatim). Ordered most-specific first.
 */
export const SECRET_RULES: RedactionRule[] = [
  {
    id: 'private-key',
    description: 'PEM/OpenSSH private key header',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/dg,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/dg,
  },
  {
    id: 'github-pat',
    description: 'GitHub personal/oauth/app token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/dg,
  },
  {
    id: 'github-fine-grained',
    description: 'GitHub fine-grained PAT',
    regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/dg,
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/dg,
  },
  {
    id: 'slack-token',
    description: 'Slack bot/user/app token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/dg,
  },
  {
    id: 'slack-webhook',
    description: 'Slack incoming webhook',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/dg,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/dg,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/dg,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/dg,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/dg,
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret/restricted key',
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/dg,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/dg,
  },
  {
    id: 'sendgrid-key',
    description: 'SendGrid API key',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/dg,
  },
  {
    id: 'twilio-key',
    description: 'Twilio API key',
    regex: /\bSK[0-9a-fA-F]{32}\b/dg,
  },
  {
    id: 'connection-string',
    description: 'Database/queue connection string with credentials',
    regex:
      /\b(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|rediss|amqp|amqps):\/\/[^\s:@'"]+:[^\s@'"]+@[^\s'"]+/dg,
  },
  {
    id: 'bearer-token',
    description: 'HTTP Authorization bearer token',
    regex: /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/dgi,
  },
  {
    id: 'generic-assignment',
    description: 'Secret-like value assigned to a credential field',
    regex:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|secret|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})/dgi,
    group: 1,
  },
];

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface Span {
  start: number;
  end: number;
  ruleId: string;
}

export interface RedactionMatch {
  ruleId: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionMatch[];
}

export interface RedactorOptions {
  rules?: RedactionRule[];
  /** Bits/char threshold for unknown-token entropy detection (0 disables). */
  entropyThreshold?: number;
  minEntropyTokenLen?: number;
  replacement?: (ruleId: string) => string;
}

function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Fail-closed secret redactor. Known patterns are redacted by rule; unknown
 * high-entropy tokens (mixed letters+digits) are redacted as `entropy`.
 * Apply to free-text payload fields before emission/persistence.
 */
export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly entropyThreshold: number;
  private readonly minTokenLen: number;
  private readonly replacement: (ruleId: string) => string;
  private readonly tokenRegex: RegExp;

  constructor(options: RedactorOptions = {}) {
    this.rules = options.rules ?? SECRET_RULES;
    this.entropyThreshold = options.entropyThreshold ?? 3.5;
    this.minTokenLen = options.minEntropyTokenLen ?? 20;
    this.replacement = options.replacement ?? ((ruleId) => `[REDACTED:${ruleId}]`);
    this.tokenRegex = new RegExp(`[A-Za-z0-9+/=_-]{${this.minTokenLen},}`, 'g');
  }

  redact(text: string): RedactionResult {
    charsTotal.inc(text.length);
    const spans: Span[] = [];

    for (const rule of this.rules) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.regex.exec(text)) !== null) {
        const group = rule.group ?? 0;
        const indices = match.indices;
        const span = indices?.[group] ?? indices?.[0];
        if (span && span[1] > span[0]) {
          spans.push({ start: span[0], end: span[1], ruleId: rule.id });
        }
        if (match.index === rule.regex.lastIndex) rule.regex.lastIndex++;
      }
    }

    if (this.entropyThreshold > 0) {
      this.tokenRegex.lastIndex = 0;
      let token: RegExpExecArray | null;
      while ((token = this.tokenRegex.exec(text)) !== null) {
        const value = token[0];
        const start = token.index;
        const end = start + value.length;
        if (spans.some((s) => start < s.end && end > s.start)) continue;
        if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
        if (shannonEntropy(value) >= this.entropyThreshold) {
          spans.push({ start, end, ruleId: 'entropy' });
        }
      }
    }

    const merged = mergeSpans(spans);
    if (merged.length === 0) {
      return { text, redactions: [] };
    }

    let out = '';
    let cursor = 0;
    const redactions: RedactionMatch[] = [];
    for (const span of merged) {
      out += text.slice(cursor, span.start) + this.replacement(span.ruleId);
      redactions.push({ ruleId: span.ruleId, start: span.start, end: span.end });
      cursor = span.end;
    }
    out += text.slice(cursor);
    matchesTotal.inc(redactions.length);
    return { text: out, redactions };
  }

  redactString(text: string): string {
    return this.redact(text).text;
  }
}

export const redactor = new Redactor();

export function redact(text: string): string {
  return redactor.redactString(text);
}

/** Free-text payload fields that may carry secrets; structural fields are left intact. */
export const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'output_excerpt',
  'error_excerpt',
  'command_display',
  'prompt_summary',
  'summary',
  'body',
  'claim_text',
  'message_summary',
  'detail',
  'tool_input_summary',
]);

function redactValue(value: unknown, instance: Redactor): unknown {
  if (typeof value === 'string') return instance.redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, instance));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, instance);
    return out;
  }
  return value;
}

/**
 * Redact secret-bearing free-text fields of an event payload without corrupting
 * structural values (paths, oids, hashes, names, ids). Returns a new object.
 */
export function redactPayload(
  payload: Record<string, unknown>,
  instance: Redactor = redactor,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const key of Object.keys(out)) {
    if (FREE_TEXT_KEYS.has(key)) {
      out[key] = redactValue(out[key], instance);
    }
  }
  return out;
}
