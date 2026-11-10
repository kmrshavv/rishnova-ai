const FORWARDED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'origin',
  'cf-connecting-ip',
  'access-control-request-method',
  'access-control-request-headers',
  'access-control-request-private-network'
];
const MAX_REQUEST_BYTES = 48 * 1024;

function jsonError(status, detail) {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

async function readBoundedBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function onRequest({ request, env }) {
  const method = request.method.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(method)) {
    return jsonError(405, 'This request method is not supported.');
  }

  let backend;
  try {
    backend = new URL(env.BACKEND_API_URL || '');
  } catch {
    console.error('BACKEND_API_URL is missing or invalid.');
    return jsonError(503, 'The backend API is not configured.');
  }
  if (
    backend.protocol !== 'https:'
    || backend.username
    || backend.password
    || backend.pathname !== '/'
    || backend.search
    || backend.hash
    || backend.origin === new URL(request.url).origin
  ) {
    console.error('BACKEND_API_URL must be a separate HTTPS origin.');
    return jsonError(503, 'The backend API is not configured correctly.');
  }

  const incoming = new URL(request.url);
  backend.pathname = incoming.pathname;
  backend.search = incoming.search;
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { method, headers, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    const body = await readBoundedBody(request);
    if (body === null) return jsonError(413, 'Request body is too large.');
    if (body.byteLength) init.body = body;
  }

  try {
    const upstream = await fetch(new Request(backend, init));
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    console.error('Backend API proxy request failed:', error);
    return jsonError(502, 'The backend API could not be reached.');
  }
}
