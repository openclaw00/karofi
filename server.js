const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const rootDir = __dirname;
loadEnvFile(path.join(rootDir, '.env'));

const apiOrders = require('./api/orders');

const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  try {
    const text = fsSync.readFileSync(filePath, 'utf8');
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) return;
      const key = trimmed.slice(0, equalsIndex).trim();
      const value = parseEnvValue(trimmed.slice(equalsIndex + 1));
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch (_) {
    // Local .env is optional.
  }
}

function sendLocalJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/api/orders') {
    sendLocalJson(response, 404, { error: 'API route not found' });
    return;
  }

  let body = {};
  if (request.method !== 'GET') {
    try {
      body = JSON.parse(await readRequestBody(request) || '{}');
    } catch (_) {
      sendLocalJson(response, 400, { error: 'Invalid JSON body' });
      return;
    }
  }

  const vercelRequest = { method: request.method, headers: request.headers, body };
  const vercelResponse = {
    setHeader(name, value) {
      response.setHeader(name, value);
    },
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(payload) {
      sendLocalJson(response, response.statusCode || 200, payload);
    }
  };

  await apiOrders(vercelRequest, vercelResponse);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(rootDir, requestedPath));

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    response.end(body);
  } catch (_) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url.startsWith('/api/')) {
    await handleApi(request, response);
    return;
  }
  await serveStatic(request, response);
});

server.listen(port, () => {
  console.log(`Karofi store running at http://localhost:${port}`);
  console.log('Production orders use Vercel /api/orders -> Supabase + optional email.');
});
