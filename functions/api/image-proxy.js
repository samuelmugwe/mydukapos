// functions/api/image-proxy.js — Cloudflare Pages Function
//
// Fetches an external image server-side and streams it back with permissive
// CORS headers, so the browser can load it into a <canvas> for resizing
// (see readImageAsScaledDataUrl in index.html) without hitting cross-origin
// restrictions that many third-party image hosts don't lift for direct
// browser fetches.
//
// Used specifically for pulling a product photo from a barcode lookup
// (barcode-lookup.js returns an external image URL from UPCitemdb or Open
// Food Facts) into the Add New Items form automatically.
//
// SAFETY: only proxies http(s) URLs, rejects anything pointing at a private/
// internal address (basic SSRF guard), caps the response size, and only
// ever returns image content-types — never arbitrary files.

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB — generous; the frontend downsizes further anyway

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Rejects obviously-private/internal targets. Not exhaustive (a determined
// attacker could still find a redirect chain into an internal address), but
// blocks the easy cases — this proxy only ever forwards a URL that came from
// barcode-lookup.js's own trusted responses in normal use, so the risk is low.
function isSafeUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  return true;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request } = context;
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get('url');
  if (!target) return errorResponse('Missing url parameter.');

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch (e) {
    return errorResponse('Invalid url.');
  }
  if (!isSafeUrl(parsedTarget)) return errorResponse('That URL is not allowed.');

  let upstream;
  try {
    upstream = await fetch(parsedTarget.toString(), {
      headers: { 'User-Agent': 'MinimartPOS-ImageProxy/1.0' },
    });
  } catch (e) {
    return errorResponse('Could not fetch that image.', 502);
  }

  if (!upstream.ok) return errorResponse('Image not found at that URL.', 404);

  const contentType = upstream.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return errorResponse('That URL is not an image.', 415);

  const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_IMAGE_BYTES) return errorResponse('Image is too large.', 413);

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return errorResponse('Image is too large.', 413);

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    },
  });
}
