import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (excludes I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LEN = TIME_LEN + RANDOM_LEN;

/** Matches a canonical (uppercase) ULID; validation is case-insensitive. */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isUlid(value: string): boolean {
  return typeof value === 'string' && ULID_REGEX.test(value);
}

function encodeTime(time: number, len: number): string {
  if (!Number.isInteger(time) || time < 0 || time > 281474976710655) {
    throw new RangeError(`ulid: timestamp out of range: ${time}`);
  }
  let out = '';
  let remaining = time;
  for (let i = 0; i < len; i++) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING.charAt((value >>> bits) & 31);
    }
  }
  return out;
}

function incrementBytes(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0xff) {
      bytes[i] = 0;
    } else {
      bytes[i] = (bytes[i] as number) + 1;
      return true;
    }
  }
  return false;
}

export type UlidFactory = () => string;

/**
 * Monotonic ULID factory: within the same millisecond the random component is
 * incremented so ids sort in generation order. `now` is injectable for tests.
 */
export function ulidFactory(now: () => number = Date.now): UlidFactory {
  let lastTime = -1;
  let lastRandom: Uint8Array = randomBytes(10);

  return (): string => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      if (!incrementBytes(lastRandom)) {
        time = lastTime + 1;
        lastRandom = randomBytes(10);
      }
    } else {
      lastRandom = randomBytes(10);
    }
    lastTime = time;
    return encodeTime(time, TIME_LEN) + encodeRandom(lastRandom);
  };
}

/** Default monotonic generator. */
export const ulid: UlidFactory = ulidFactory();

/** Decode the millisecond timestamp encoded in a ULID (for diagnostics). */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`ulid: invalid id: ${id}`);
  const timePart = id.slice(0, TIME_LEN).toUpperCase();
  let time = 0;
  for (const char of timePart) {
    time = time * ENCODING_LEN + ENCODING.indexOf(char);
  }
  return time;
}
