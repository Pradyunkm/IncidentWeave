/**
 * Security and validation utilities for IncidentWeave
 */

// Safe identifier: alphanumeric, dash, underscore, 1-64 chars
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidIdentifier(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  return SAFE_ID_REGEX.test(val);
}

export function sanitizeText(val: unknown, maxLength = 2000): string {
  if (typeof val !== 'string') return '';
  return val
    .trim()
    .slice(0, maxLength)
    .replace(/[<>]/g, ''); // strip potential html tag markers to prevent XSS
}

export function isValidUid(val: unknown): boolean {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val > 0 && val < 4294967295;
  }
  if (typeof val === 'string') {
    return /^\d{1,10}$/.test(val) && Number(val) > 0;
  }
  return false;
}

// In-memory sliding-window rate limiter (fallback & fast path)
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Clean up stale entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
      if (now > entry.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

/**
 * Check rate limit for a given key (e.g. client IP or UID)
 * @param key Identifier (e.g. IP)
 * @param limit Max requests allowed in the window
 * @param windowMs Window duration in milliseconds (default 60s)
 * @returns { allowed: boolean, remaining: number }
 */
export function checkRateLimit(key: string, limit = 60, windowMs = 60000): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count };
}

/**
 * Extract client IP from NextRequest headers safely
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  return '127.0.0.1';
}
