const crypto = require('crypto');

const sheetId = process.env.GOOGLE_SHEET_ID;
const sheetTab = process.env.GOOGLE_SHEET_TAB || 'Orders';
const googleClientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const googlePrivateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseOrdersTable = process.env.SUPABASE_ORDERS_TABLE || 'orders';
const resendApiKey = process.env.RESEND_API_KEY;
const orderEmailTo = process.env.ORDER_EMAIL_TO;
const orderEmailFrom = process.env.ORDER_EMAIL_FROM || 'Karofi Store <orders@resend.dev>';
const adminOrdersToken = process.env.ADMIN_ORDERS_TOKEN;
const maxBodySize = 100_000;

const headers = [
  'Order ID',
  'Created At',
  'Status',
  'Customer Name',
  'Phone',
  'Email',
  'Address',
  'Delivery Time',
  'Payment',
  'Note',
  'Items',
  'Total',
  'Raw JSON'
];

const products = {
  'sa9-premium': {
    name: 'Máy lọc nước nóng lạnh Hydro-ion Kiềm Karofi SA9 PREMIUM',
    price: 49900000
  },
  'diamond-sa66': {
    name: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi DIAMOND SA66',
    price: 59000000
  },
  'kae-s688': {
    name: 'Máy lọc nước Hydro-ion kiềm nóng lạnh Karofi KAE-S688',
    price: 21990000
  },
  'kae-s695': {
    name: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi KAE-S695',
    price: 31890000
  },
  'kae-s88-promax': {
    name: 'Máy lọc nước nóng lạnh Hydro-ion kiềm Karofi KAE-S88 PROMAX',
    price: 39490000
  }
};

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function cleanText(value) {
  return String(value || '').trim();
}

function getHeader(request, name) {
  const headers = request.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || '';
}

function isAuthorizedAdminRequest(request) {
  if (!adminOrdersToken) return process.env.VERCEL !== '1';
  const authHeader = getHeader(request, 'authorization');
  const dashboardToken = getHeader(request, 'x-orders-token');
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  return dashboardToken === adminOrdersToken || bearerToken === adminOrdersToken;
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body || '{}');
    } catch (_) {
      throw new Error('Invalid JSON body');
    }
  }

  return await new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBodySize) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function validateOrderPayload(payload) {
  const customer = payload && payload.customer ? payload.customer : {};
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const cleanedItems = items
    .map((item) => {
      const id = cleanText(item.id);
      const product = products[id];
      if (!product) return null;
      return {
        id,
        name: product.name,
        price: product.price,
        quantity: Math.min(20, Math.max(1, Number(item.quantity) || 1))
      };
    })
    .filter(Boolean);

  const cleaned = {
    customer: {
      name: cleanText(customer.name),
      phone: cleanText(customer.phone),
      email: cleanText(customer.email),
      address: cleanText(customer.address),
      deliveryTime: cleanText(customer.deliveryTime),
      payment: cleanText(customer.payment) || 'Thanh toán khi nhận hàng',
      note: cleanText(customer.note)
    },
    items: cleanedItems
  };

  if (!cleaned.customer.name) return { error: 'Missing customer name' };
  if (!cleaned.customer.phone) return { error: 'Missing customer phone' };
  if (!cleaned.customer.address) return { error: 'Missing shipping address' };
  if (!cleaned.items.length) return { error: 'Order has no items' };

  return { order: cleaned };
}

function createOrder(payload) {
  return {
    id: `KRF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    createdAt: new Date().toISOString(),
    status: 'Chờ xử lý',
    customer: payload.customer,
    items: payload.items,
    total: payload.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  };
}

function assertGoogleConfig() {
  if (!sheetId || !googleClientEmail || !googlePrivateKey) {
    throw new Error('Google Sheets is not configured. Set GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in Vercel.');
  }
}

function hasSupabaseConfig() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

function hasGoogleConfig() {
  return Boolean(sheetId && googleClientEmail && googlePrivateKey);
}

function assertStorageConfig() {
  if (hasSupabaseConfig()) return;
  if (hasGoogleConfig()) return;
  throw new Error('Order storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.');
}

function normalizeSupabaseOrder(row) {
  return {
    id: row.order_id,
    createdAt: row.created_at,
    status: row.status,
    customer: row.customer || {},
    items: row.items || [],
    total: Number(row.total) || 0
  };
}

async function supabaseFetch(path, options = {}) {
  if (!hasSupabaseConfig()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.');
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || result?.hint || `Supabase request failed (${response.status})`);
  }
  return result;
}

async function insertOrderToSupabase(order) {
  const rows = await supabaseFetch(supabaseOrdersTable, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      order_id: order.id,
      status: order.status,
      customer: order.customer,
      items: order.items,
      total: order.total,
      raw_order: order
    })
  });
  return Array.isArray(rows) && rows[0] ? normalizeSupabaseOrder(rows[0]) : order;
}

async function readOrdersFromSupabase() {
  const query = new URLSearchParams({
    select: 'order_id,created_at,status,customer,items,total',
    order: 'created_at.desc'
  });
  const rows = await supabaseFetch(`${supabaseOrdersTable}?${query.toString()}`);
  return Array.isArray(rows) ? rows.map(normalizeSupabaseOrder) : [];
}

async function getGoogleAccessToken() {
  assertGoogleConfig();
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const jwtClaim = base64Url(JSON.stringify({
    iss: googleClientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const unsignedToken = `${jwtHeader}.${jwtClaim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(googlePrivateKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedToken}.${signature}`
    })
  });

  const result = await response.json();
  if (!response.ok) throw new Error(result.error_description || result.error || 'Google auth failed');
  return result.access_token;
}

async function sheetsFetch(path, options = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `Google Sheets request failed (${response.status})`);
  }
  return result;
}

async function ensureHeaders() {
  const range = encodeURIComponent(`${sheetTab}!A1:M1`);
  const existing = await sheetsFetch(`/values/${range}`);
  if (existing.values && existing.values[0] && existing.values[0][0] === headers[0]) return;

  await sheetsFetch(`/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] })
  });
}

function orderToRow(order) {
  return [
    order.id,
    order.createdAt,
    order.status,
    order.customer.name,
    order.customer.phone,
    order.customer.email,
    order.customer.address,
    order.customer.deliveryTime,
    order.customer.payment,
    order.customer.note,
    order.items.map((item) => `${item.quantity} x ${item.name} (${item.price})`).join('\n'),
    order.total,
    JSON.stringify(order)
  ];
}

async function appendOrderToSheet(order) {
  await ensureHeaders();
  const range = encodeURIComponent(`${sheetTab}!A:M`);
  await sheetsFetch(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [orderToRow(order)] })
  });
}

async function readOrdersFromSheet() {
  assertGoogleConfig();
  const range = encodeURIComponent(`${sheetTab}!A2:M`);
  const result = await sheetsFetch(`/values/${range}`);
  const rows = result.values || [];
  return rows.reverse().map((row) => {
    if (row[12]) {
      try { return JSON.parse(row[12]); } catch (_) {}
    }
    return {
      id: row[0],
      createdAt: row[1],
      status: row[2],
      customer: {
        name: row[3],
        phone: row[4],
        email: row[5],
        address: row[6],
        deliveryTime: row[7],
        payment: row[8],
        note: row[9]
      },
      items: [{ id: '', name: row[10] || 'Order item', price: Number(row[11]) || 0, quantity: 1 }],
      total: Number(row[11]) || 0
    };
  });
}

async function saveOrder(order) {
  if (hasSupabaseConfig()) return await insertOrderToSupabase(order);
  assertStorageConfig();
  await appendOrderToSheet(order);
  return order;
}

async function readOrders() {
  if (hasSupabaseConfig()) return await readOrdersFromSupabase();
  assertStorageConfig();
  return await readOrdersFromSheet();
}

function formatMoney(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  }).format(amount);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendOrderEmail(order) {
  if (!resendApiKey || !orderEmailTo) {
    throw new Error('Email is not configured. Set RESEND_API_KEY and ORDER_EMAIL_TO in Vercel.');
  }

  const itemsHtml = order.items.map((item) => (
    `<li>${escapeHtml(item.quantity)} x ${escapeHtml(item.name)} - ${escapeHtml(formatMoney(item.price * item.quantity))}</li>`
  )).join('');

  const html = `
    <h1>New Karofi order: ${escapeHtml(order.id)}</h1>
    <p><strong>Total:</strong> ${escapeHtml(formatMoney(order.total))}</p>
    <h2>Customer</h2>
    <p>
      <strong>Name:</strong> ${escapeHtml(order.customer.name)}<br>
      <strong>Phone:</strong> ${escapeHtml(order.customer.phone)}<br>
      <strong>Email:</strong> ${escapeHtml(order.customer.email || '-')}<br>
      <strong>Address:</strong> ${escapeHtml(order.customer.address)}<br>
      <strong>Delivery time:</strong> ${escapeHtml(order.customer.deliveryTime || '-')}<br>
      <strong>Payment:</strong> ${escapeHtml(order.customer.payment)}<br>
      <strong>Note:</strong> ${escapeHtml(order.customer.note || '-')}
    </p>
    <h2>Items</h2>
    <ul>${itemsHtml}</ul>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: orderEmailFrom,
      to: orderEmailTo.split(',').map((email) => email.trim()).filter(Boolean),
      subject: `New Karofi COD order ${order.id}`,
      html
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Email send failed (${response.status})`);
}

module.exports = async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');

  if (request.method === 'GET') {
    try {
      if (!isAuthorizedAdminRequest(request)) {
        response.status(401).json({ error: 'Orders dashboard token is required.' });
        return;
      }
      const orders = await readOrders();
      response.status(200).json({ orders });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
    return;
  }

  if (request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const validated = validateOrderPayload(payload);
      if (validated.error) {
        response.status(400).json({ error: validated.error });
        return;
      }

      const order = await saveOrder(createOrder(validated.order));
      let emailSent = false;
      let emailError = '';
      try {
        await sendOrderEmail(order);
        emailSent = true;
      } catch (error) {
        emailError = error.message;
        console.error(`Order ${order.id} was saved, but email notification failed: ${emailError}`);
      }
      response.status(201).json({ order, emailSent, emailError });
    } catch (error) {
      const status = error.message === 'Invalid JSON body' || error.message === 'Request body too large' ? 400 : 500;
      response.status(status).json({ error: error.message });
    }
    return;
  }

  response.setHeader('allow', 'GET, POST');
  response.status(405).json({ error: 'Method not allowed' });
};
