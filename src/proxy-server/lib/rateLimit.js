/* eslint-disable no-undef */
/**
 * rateLimit — minimal in-memory per-IP rate limiter for public endpoints.
 *
 * No external dependencies. Sliding window per IP. Suitable for basic abuse
 * protection on low-volume public routes (capture form). Not distributed —
 * per-process. For higher guarantees, replace with a Redis-backed limiter later.
 */
'use strict';

function rateLimit({ windowMs = 60 * 1000, max = 30 } = {}) {
  const hits = new Map();
  return function rateLimiter(req, res, next) {
    const ip = (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').toString();
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please try again shortly.' });
    }
    // opportunistic cleanup of expired entries to bound memory
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    next();
  };
}

module.exports = { rateLimit };