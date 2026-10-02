import crypto from 'node:crypto';

export type RedactionMode = 'mask' | 'hash' | 'partial';

export interface Redaction {
  entity: string;
  start: number;
  end: number;
  token: string;
}

export interface PiiScrubOptions {
  mode?: RedactionMode;
  secret?: string | Buffer;
  blockOn?: string[];
  keepTailMap?: Record<string, number>;
}

export interface EgressSanitizationResult {
  redacted_keys_count: number;
  sanitized_payload: any;
  redactions: Redaction[];
}

interface Detector {
  name: string;
  pattern: RegExp;
  validate?: (value: string) => boolean;
  keepTail?: number;
  gate?: string[];
}

function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, '').split('').map(Number);
  if (nums.length < 13) return false;
  let total = 0;
  const parity = nums.length % 2;
  for (let i = 0; i < nums.length; i++) {
    let d = nums[i];
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

function nhsCheck(value: string): boolean {
  const nums = value.replace(/\D/g, '').split('').map(Number);
  if (nums.length !== 10) return false;
  let total = 0;
  for (let i = 0; i < 9; i++) {
    total += nums[i] * (10 - i);
  }
  let check = 11 - (total % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === nums[9];
}

const DETECTORS: Detector[] = [
  {
    name: 'CARD',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: luhnCheck,
    keepTail: 4,
  },
  {
    name: 'SSN',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    gate: ['-'],
  },
  {
    name: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    name: 'EMAIL',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g,
    gate: ['@'],
  },
  {
    name: 'AWS_KEY',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    gate: ['AKIA', 'ASIA'],
  },
  {
    name: 'API_KEY',
    pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'BEARER',
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    gate: ['ey'],
  },
  {
    name: 'MRN',
    pattern: /\b(?:MRN|mrn)[:\s#]*([A-Z0-9]{6,12})\b/g,
    gate: ['MRN', 'mrn'],
  },
  {
    name: 'NHS',
    pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g,
    validate: nhsCheck,
  },
  {
    name: 'PHONE',
    pattern: /(?<![\d.])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)|\d{2,4})[ -]\d{2,4}[ -]?\d{2,4}(?![\d.])|(?<![\d.])\d{3}-\d{3}-\d{4}(?![\d.])/g,
    keepTail: 4,
  },
  {
    name: 'IPV4',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    gate: ['.'],
  },
  {
    name: 'DOB',
    pattern: /\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b/g,
    gate: ['19', '20'],
  },
];

const SENSITIVE_KEY_NAMES = [
  'email',
  'ip',
  'host',
  'token',
  'secret',
  'key',
  'phone',
  'password',
  'authorization',
];

export class PiiScrubber {
  public readonly mode: RedactionMode;
  public readonly secret: Buffer;
  public readonly blockOn: Set<string>;
  private readonly gateRegex = /[\d@]/;

  constructor(options: PiiScrubOptions = {}) {
    this.mode = options.mode || 'mask';
    this.secret = Buffer.isBuffer(options.secret)
      ? options.secret
      : Buffer.from(options.secret || process.env.ACR_PII_SECRET || 'acr-bridge-default-pii-secret');
    this.blockOn = new Set(options.blockOn || []);
  }

  private generateToken(entity: string, value: string, keepTail = 0): string {
    if (this.mode === 'mask') {
      return `<${entity}>`;
    }
    if (this.mode === 'hash') {
      const hmac = crypto.createHmac('sha256', this.secret).update(value).digest('hex').substring(0, 8);
      return `<${entity}:${hmac}>`;
    }
    if (this.mode === 'partial' && keepTail > 0) {
      const alphanumeric = value.replace(/[^a-zA-Z0-9]/g, '');
      const tail = alphanumeric.slice(-keepTail);
      return `<${entity}:****${tail}>`;
    }
    return `<${entity}>`;
  }

  public scrubText(text: string): { text: string; redactions: Redaction[] } {
    if (!text || typeof text !== 'string') {
      return { text: '', redactions: [] };
    }

    if (!this.gateRegex.test(text)) {
      return { text, redactions: [] };
    }

    interface MatchSpan {
      start: number;
      end: number;
      det: Detector;
      value: string;
    }

    const spans: MatchSpan[] = [];

    for (const det of DETECTORS) {
      if (det.gate && !det.gate.some((g) => text.includes(g))) {
        continue;
      }

      det.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = det.pattern.exec(text)) !== null) {
        const val = m[0];
        if (det.validate && !det.validate(val)) {
          continue;
        }
        spans.push({
          start: m.index,
          end: m.index + val.length,
          det,
          value: val,
        });
      }
    }

    if (spans.length === 0) {
      return { text, redactions: [] };
    }

    // Earliest start wins, longer match tiebreaks
    spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const parts: string[] = [];
    const redactions: Redaction[] = [];
    let cursor = 0;

    for (const span of spans) {
      if (span.start < cursor) {
        continue;
      }

      if (this.blockOn.has(span.det.name)) {
        throw new Error(`PII Scrubber blocked: entity "${span.det.name}" is prohibited in outbound egress.`);
      }

      const token = this.generateToken(span.det.name, span.value, span.det.keepTail || 0);
      parts.push(text.slice(cursor, span.start));
      parts.push(token);
      redactions.push({
        entity: span.det.name,
        start: span.start,
        end: span.end,
        token,
      });
      cursor = span.end;
    }

    parts.push(text.slice(cursor));
    return {
      text: parts.join(''),
      redactions,
    };
  }

  public scrub(payload: any): EgressSanitizationResult {
    let redactedKeysCount = 0;
    const allRedactions: Redaction[] = [];

    const recurse = (val: any): any => {
      if (val === null || val === undefined) {
        return val;
      }

      if (typeof val === 'string') {
        if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
          try {
            const parsed = JSON.parse(val);
            const scrubbedJson = recurse(parsed);
            return JSON.stringify(scrubbedJson);
          } catch {
            // not json
          }
        }

        const { text, redactions } = this.scrubText(val);
        if (redactions.length > 0) {
          allRedactions.push(...redactions);
          redactedKeysCount += redactions.length;
        }
        return text;
      }

      if (Array.isArray(val)) {
        return val.map((item) => recurse(item));
      }

      if (typeof val === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
          const lk = k.toLowerCase();
          const isSensitive = SENSITIVE_KEY_NAMES.some((s) => lk.includes(s));
          if (isSensitive) {
            out[k] = '[redacted]';
            redactedKeysCount++;
          } else {
            out[k] = recurse(v);
          }
        }
        return out;
      }

      return val;
    };

    const sanitized = recurse(payload);
    return {
      redacted_keys_count: redactedKeysCount,
      sanitized_payload: sanitized,
      redactions: allRedactions,
    };
  }
}

export function scrubPii(payload: any, options?: PiiScrubOptions): EgressSanitizationResult {
  const scrubber = new PiiScrubber(options);
  return scrubber.scrub(payload);
}

export function scrubPiiText(text: string, options?: PiiScrubOptions): { text: string; redactions: Redaction[] } {
  const scrubber = new PiiScrubber(options);
  return scrubber.scrubText(text);
}
