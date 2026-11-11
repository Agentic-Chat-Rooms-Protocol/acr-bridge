/**
 * SafeEgressDialer: Hardened SSRF and DNS-rebinding defense for webhook egress targets.
 *
 * Explicitly blocks:
 * - RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Loopback addresses (127.0.0.0/8, ::1)
 * - Unspecified / wildcard addresses (0.0.0.0/8, ::, 0:0:0:0:0:0:0:0)
 * - Link-local & Cloud IMDS metadata (169.254.0.0/16, fe80::/10)
 * - CGNAT / Tailscale (100.64.0.0/10)
 * - IPv4-mapped IPv6 addresses in both dotted-quad and hex forms (::ffff:0:0/96, e.g., ::ffff:127.0.0.1, ::ffff:169.254.169.254, ::ffff:10.0.0.1, ::ffff:7f00:1)
 * - IPv4-compatible IPv6 (::/96), NAT64 (64:ff9b::/96), ULA (fc00::/7), multicast (224.0.0.0/4, ff00::/8)
 * - Octal (0177.0.0.1), hexadecimal (0x7f.0.0.1, 0x7f000001), integer/dword (2130706433), and shorthand (127.1) IP literals
 */

export class SafeEgressDialer {
  /**
   * Detects non-canonical IP literals (octal, hexadecimal, integer/dword, or shorthand numeric IPv4)
   * that could be used to bypass string-based SSRF filters.
   */
  public static isNonCanonicalIpLiteral(input: string): boolean {
    const s = input.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!s) return true;

    // Pure decimal integer (dword IP like 2130706433) or single hex literal (0x7f000001)
    if (/^\d+$/.test(s) || /^0x[0-9a-f]+$/i.test(s)) {
      return true;
    }

    if (s.includes('.') && !s.includes(':')) {
      const parts = s.split('.');
      const allNumericOrHex = parts.every(
        (p) => /^0x[0-9a-f]+$/i.test(p) || /^\d+$/.test(p)
      );
      if (allNumericOrHex) {
        if (parts.length !== 4) {
          return true; // Shorthand IPv4 like 127.1 or 127.0.1
        }
        // Any part using hex prefix (0x...) or leading zero octal (0177)
        if (parts.some((p) => /^0x/i.test(p) || (/^0\d+$/.test(p) && p !== '0'))) {
          return true;
        }
      }
    }

    return false;
  }

  public static isPublicIpv4(ip: string): boolean {
    const trimmed = ip.trim();
    if (SafeEgressDialer.isNonCanonicalIpLiteral(trimmed)) {
      return false;
    }

    const parts = trimmed.split('.');
    if (parts.length !== 4) return false;
    if (parts.some((p) => !/^(0|[1-9]\d*)$/.test(p))) return false;
    const octets = parts.map((p) => Number(p));
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;

    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return false; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT / Tailscale
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 Link-local / Cloud IMDS
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC1918
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 Benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return false; // Multicast & reserved (224.0.0.0/4+)
    return true;
  }

  /**
   * Parses an IPv6 string into 8 16-bit hextets (0..0xffff), supporting `::` compression
   * and embedded trailing IPv4 dotted-quads. Returns null if malformed.
   */
  public static parseIpv6Hextets(ip: string): number[] | null {
    let raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!raw || !raw.includes(':')) return null;
    // Reject zone indices (%eth0)
    if (raw.includes('%')) return null;

    // If embedded trailing IPv4 dotted-quad is present (e.g. ::ffff:127.0.0.1), convert last segment to 2 hextets
    const lastColon = raw.lastIndexOf(':');
    const tail = raw.slice(lastColon + 1);
    if (tail.includes('.')) {
      const parts = tail.split('.');
      if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d*)$/.test(p))) {
        return null;
      }
      const nums = parts.map((p) => Number(p));
      if (nums.some((n) => n < 0 || n > 255)) return null;
      const hi = ((nums[0] << 8) | nums[1]).toString(16);
      const lo = ((nums[2] << 8) | nums[3]).toString(16);
      raw = `${raw.slice(0, lastColon + 1)}${hi}:${lo}`;
    }

    const doubleColonParts = raw.split('::');
    if (doubleColonParts.length > 2) return null;

    const parseGroupList = (segment: string): number[] | null => {
      if (segment === '') return [];
      const groups = segment.split(':');
      const out: number[] = [];
      for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
      return out;
    };

    if (doubleColonParts.length === 2) {
      const left = parseGroupList(doubleColonParts[0]);
      const right = parseGroupList(doubleColonParts[1]);
      if (!left || !right) return null;
      const missing = 8 - (left.length + right.length);
      if (missing < 1) return null;
      return [...left, ...new Array(missing).fill(0), ...right];
    }

    const full = parseGroupList(raw);
    if (!full || full.length !== 8) return null;
    return full;
  }

  public static isPublicIpAddress(ip: string): boolean {
    const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!trimmed) return false;

    if (SafeEgressDialer.isNonCanonicalIpLiteral(trimmed)) {
      return false;
    }

    if (!trimmed.includes(':')) {
      return SafeEgressDialer.isPublicIpv4(trimmed);
    }

    const hextets = SafeEgressDialer.parseIpv6Hextets(trimmed);
    if (!hextets) return false;

    const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

    // 1. Unspecified (:: / 0:0:0:0:0:0:0:0) or Loopback (::1)
    const first6Zero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
    if (first6Zero && h6 === 0 && (h7 === 0 || h7 === 1)) {
      return false;
    }

    // 2. IPv4-mapped IPv6 (::ffff:0:0/96, including ::ffff:127.0.0.1, ::ffff:169.254.169.254, ::ffff:10.0.0.1, ::ffff:7f00:1)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return false;
    }

    // 3. IPv4-compatible IPv6 (::/96)
    if (first6Zero) {
      return false;
    }

    // 4. NAT64 Well-Known Prefix (64:ff9b::/96) and 6to4 (2002::/16)
    if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      return false;
    }
    if (h0 === 0x2002) {
      return false;
    }

    // 5. Link-local (fe80::/10), Unique Local (fc00::/7), Multicast (ff00::/8), Documentation (2001:db8::/32)
    if ((h0 & 0xffc0) === 0xfe80) return false;
    if ((h0 & 0xfe00) === 0xfc00) return false;
    if ((h0 & 0xff00) === 0xff00) return false;
    if (h0 === 0x2001 && h1 === 0x0db8) return false;

    // 6. Global unicast IPv6 range (2000::/3 -> h0 in 0x2000..0x3fff)
    return h0 >= 0x2000 && h0 <= 0x3fff;
  }

  public static validateEgressTarget(targetUrl: string, resolvedIps: string[]): {
    allowed: boolean;
    pinnedIp?: string;
    reason?: string;
  } {
    // Pre-parse check for raw octal/hex/integer host literals before WHATWG URL normalizes them
    const rawHostMatch = /^\s*https?:\/\/\[?([^\/:?#\s\]]+)\]?/i.exec(targetUrl);
    if (rawHostMatch) {
      const rawHost = rawHostMatch[1];
      if (SafeEgressDialer.isNonCanonicalIpLiteral(rawHost)) {
        return { allowed: false, reason: `NON_CANONICAL_IP_LITERAL_BLOCKED:${rawHost}` };
      }
      if (
        (rawHost.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(rawHost)) &&
        !SafeEgressDialer.isPublicIpAddress(rawHost)
      ) {
        return { allowed: false, reason: `NON_PUBLIC_HOST_LITERAL_BLOCKED:${rawHost}` };
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { allowed: false, reason: 'INVALID_URL' };
    }

    if (parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'HTTPS_REQUIRED' };
    }

    const effectivePort = parsed.port ? Number(parsed.port) : 443;
    if (effectivePort !== 443) {
      return { allowed: false, reason: 'PORT_443_REQUIRED' };
    }

    if (!resolvedIps || resolvedIps.length === 0) {
      return { allowed: false, reason: 'DNS_RESOLUTION_EMPTY' };
    }

    for (const ip of resolvedIps) {
      if (!SafeEgressDialer.isPublicIpAddress(ip)) {
        return { allowed: false, reason: `NON_PUBLIC_IP_BLOCKED:${ip}` };
      }
    }

    return { allowed: true, pinnedIp: resolvedIps[0] };
  }
}
