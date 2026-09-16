import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { config, ROOT } from '../config.js';
import { logger } from '../lib/log.js';
import { Router, ApiError, unauthorized, notFound } from './router.js';
import { authenticate } from './auth.js';
import { register as registerSubscriptions } from './routes/subscriptions.js';
import { register as registerEvents } from './routes/events.js';
import { register as registerCuration } from './routes/curation.js';
import { register as registerAdmin } from './routes/admin.js';

const log = logger('api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function buildRouter() {
  const router = new Router();
  router.get('/healthz', () => ({ ok: true, mode: config.ingestMode, time: new Date().toISOString() }), { public: true });
  registerEvents(router);
  registerSubscriptions(router);
  registerCuration(router);
  registerAdmin(router);
  return router;
}

async function readBody(request, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

function send(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Serve the dashboard from src/web, with a strict guard against path escape. */
async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const webRoot = resolve(ROOT, 'src/web');
  const target = resolve(webRoot, normalize(relative));
  if (!target.startsWith(webRoot + '/') && target !== resolve(webRoot, 'index.html')) return false;
  if (!existsSync(target)) return false;

  const body = await readFile(target);
  response.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  response.end(body);
  return true;
}

export function createApp() {
  const router = buildRouter();

  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const started = Date.now();

    // The dashboard is a browser app talking to the same origin; CORS is here
    // so an agent running elsewhere can also call the API directly.
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
    response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }

    try {
      const found = router.find(request.method, url.pathname);

      if (!found) {
        if (request.method === 'GET' && !url.pathname.startsWith('/v1/')) {
          if (await serveStatic(url.pathname, response)) return;
        }
        throw notFound('Endpoint');
      }

      let caller = null;
      if (!found.route.options.public) {
        caller = authenticate(request);
        if (!caller) throw unauthorized();
      }

      const body = ['POST', 'PATCH', 'PUT'].includes(request.method) ? await readBody(request) : {};
      const result = await found.route.handler({
        params: found.params,
        query: Object.fromEntries(url.searchParams),
        body,
        caller,
        request,
      });

      send(response, found.route.options.status ?? 200, result);
      log.debug(`${request.method} ${url.pathname} → ${found.route.options.status ?? 200} (${Date.now() - started}ms)`);
    } catch (error) {
      if (error instanceof ApiError) {
        send(response, error.status, { error: error.message, details: error.details });
      } else {
        log.error(`${request.method} ${url.pathname} failed`, error);
        send(response, 500, { error: 'Internal server error', message: error.message });
      }
    }
  });
}

export function startServer() {
  return new Promise((resolvePromise) => {
    const server = createApp();
    server.listen(config.port, config.host, () => {
      log.info(`Dashboard  →  http://${config.host}:${config.port}`);
      log.info(`Agent API  →  http://${config.host}:${config.port}/v1`);
      log.info(`Ingest mode: ${config.ingestMode}`);
      resolvePromise(server);
    });
  });
}
