const encoder = new TextEncoder();
const decoder = new TextDecoder();
import { bootstrap, details, event, exitPreview, orderPreview, placeOrder, positions, signalContract, snapshot } from './broker.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || !allowedOrigins(env).includes(origin)) {
    throw new Response('Origin not allowed', { status: 403 });
  }
}

function indiaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function createDailyToken(secret) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    version: 'v2',
    date: indiaDate(),
    scope: ['dashboard'],
  })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifyDailyToken(token, secret) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return false;
  let decoded;
  try {
    decoded = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
  } catch {
    return false;
  }
  if (decoded.version !== 'v2' || decoded.date !== indiaDate()) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64UrlToBytes(signature),
    encoder.encode(payload),
  );
}

async function authorizedSession(request, env) {
  return configured(env.ACCESS_SIGNING_SECRET)
    && verifyDailyToken(bearerToken(request), env.ACCESS_SIGNING_SECRET);
}

async function requestBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function sameSecret(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right || ''))),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

function configured(value) {
  const normalized = String(value || '').trim();
  return Boolean(normalized) && !normalized.startsWith('PASTE_');
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    assertAllowedOrigin(request, env);
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      service: 'neopilot-secure-gateway',
      date: indiaDate(),
      configured: {
        githubPat: configured(env.GITHUB_PAT),
        ownerKey: configured(env.OWNER_KEY),
        accessSigningSecret: configured(env.ACCESS_SIGNING_SECRET),
      },
    }, 200, cors);
  }

  assertAllowedOrigin(request, env);

  if (request.method === 'POST' && url.pathname === '/owner/access-link') {
    if (!configured(env.OWNER_KEY) || !configured(env.ACCESS_SIGNING_SECRET)) {
      return json({ error: 'Gateway secrets are not configured' }, 503, cors);
    }
    if (!(await sameSecret(bearerToken(request), env.OWNER_KEY))) {
      return json({ error: 'Owner key is invalid' }, 401, cors);
    }
    const token = await createDailyToken(env.ACCESS_SIGNING_SECRET);
    const dashboardUrl = new URL(String(env.DASHBOARD_URL || ''));
    dashboardUrl.hash = new URLSearchParams({
      access: token,
      gateway: new URL(request.url).origin,
    }).toString();
    return json({
      url: dashboardUrl.toString(),
      date: indiaDate(),
    }, 200, cors);
  }

  if (request.method === 'POST' && url.pathname === '/session/verify') {
    if (!configured(env.ACCESS_SIGNING_SECRET)) {
      return json({ error: 'Gateway signing secret is not configured' }, 503, cors);
    }
    const valid = await verifyDailyToken(bearerToken(request), env.ACCESS_SIGNING_SECRET);
    return valid
      ? json({ valid: true, date: indiaDate() }, 200, cors)
      : json({ valid: false, error: 'Access link is invalid or expired' }, 401, cors);
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!(await authorizedSession(request, env))) {
      return json({ error: 'Access link is invalid or expired', events: [] }, 401, cors);
    }
    if (!configured(env.GITHUB_PAT)) {
      return json({ error: 'GitHub access is not configured', events: [] }, 503, cors);
    }
    const body = await requestBody(request);
    const events = [];
    try {
      if (url.pathname === '/api/bootstrap') {
        return json({ ...(await bootstrap(env, events, Boolean(body.force))), events }, 200, cors);
      }
      if (url.pathname === '/api/snapshot') {
        return json({ snapshot: await snapshot(env, body.accountId, events, Boolean(body.force)), events }, 200, cors);
      }
      if (url.pathname === '/api/positions') {
        return json({ ...(await positions(env, body.accountId, events)), events }, 200, cors);
      }
      if (url.pathname === '/api/details') {
        return json({ ...(await details(env, body.accountId, events)), events }, 200, cors);
      }
      if (url.pathname === '/api/signal') {
        return json({
          accountId: String(body.accountId || ''),
          requestId: String(body.requestId || ''),
          contract: await signalContract(env, body.accountId, body.signal, events),
          events,
        }, 200, cors);
      }
      if (url.pathname === '/api/order/preview') {
        return json({ preview: await orderPreview(env, body.accountId, body.draft, events), events }, 200, cors);
      }
      if (url.pathname === '/api/order/place') {
        return json({ result: await placeOrder(env, body.accountId, body.draft, events), events }, 200, cors);
      }
      if (url.pathname === '/api/exit/preview') {
        return json({ preview: await exitPreview(env, body.accountId, body.draft, events), events }, 200, cors);
      }
    } catch (error) {
      events.push(event('Secure gateway', 'error', error instanceof Error ? error.message : 'Request failed.'));
      return json({ error: error instanceof Error ? error.message : 'Request failed.', events }, 502, cors);
    }
  }

  return json({ error: 'Route not found' }, 404, cors);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error('Gateway request failed', error);
      return json({ error: 'Gateway request failed' }, 500, corsHeaders(request, env));
    }
  },
};
