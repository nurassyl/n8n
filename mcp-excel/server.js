// MCP server exposing generic OneDrive Excel tools to Claude.ai / ChatGPT.
//
// Works with ANY .xlsx workbook on the user's OneDrive. No file pre-registration
// required — Claude discovers files via search_files / list_folder, then operates
// on them by item ID or path. Implements the MCP streamable HTTP transport at
// POST/GET/DELETE on the root path.
//
// OAuth tokens are bootstrapped from data/tokens.json (initially seeded from
// n8n's stored credential) and refreshed in-memory. New refresh tokens are
// persisted to disk so the server survives restarts.

import express from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------
const TOKENS_PATH = process.env.TOKENS_PATH || './data/tokens.json';
let accessToken = null;
let accessTokenExpiresAt = 0;
let bootstrap = null;

async function loadBootstrap() {
  const raw = await readFile(TOKENS_PATH, 'utf8');
  bootstrap = JSON.parse(raw);
  if (!bootstrap.refresh_token) throw new Error('tokens.json missing refresh_token');
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: bootstrap.client_id,
    client_secret: bootstrap.client_secret,
    refresh_token: bootstrap.refresh_token,
    grant_type: 'refresh_token',
    scope: 'offline_access openid Files.ReadWrite',
  });
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  if (data.refresh_token) {
    bootstrap.refresh_token = data.refresh_token;
    await writeFile(TOKENS_PATH, JSON.stringify(bootstrap, null, 2));
  }
}

async function getAccessToken() {
  if (!accessToken || Date.now() >= accessTokenExpiresAt) await refreshAccessToken();
  return accessToken;
}

// ---------------------------------------------------------------------------
// Microsoft Graph helpers
//
// OneDrive Personal item IDs contain `!`. Node's URL parser percent-encodes it
// to %21, which Microsoft Graph treats as a different (non-existent) resource.
// Build URLs by string concatenation and only percent-encode query values.
// ---------------------------------------------------------------------------
async function graph(method, path, { query, body } = {}) {
  const token = await getAccessToken();
  let urlStr = 'https://graph.microsoft.com/v1.0' + path;
  if (query) {
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    urlStr += (urlStr.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(urlStr, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const detail = parsed?.error?.message || text || res.statusText;
    throw new Error(`Graph ${method} ${path} → ${res.status}: ${detail}`);
  }
  return parsed;
}

// Accept either an OneDrive item ID (e.g. "1F93...!sb4b7...") or an absolute
// path ("/Documents/foo.xlsx") and produce the right Graph base path.
function workbookBase(file) {
  if (!file) throw new Error('file is required');
  if (file.startsWith('/')) {
    const encoded = file.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `/me/drive/root:/${encoded}:`;
  }
  return `/me/drive/items/${file}`;
}

function textResult(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: 'excel', version: '1.0.0' });

  // -- Discovery -----------------------------------------------------------

  server.registerTool('search_files', {
    title: 'Search OneDrive for Excel files',
    description: 'Search the user\'s OneDrive for files whose name contains the query (case-insensitive substring). Use this when the user mentions a workbook by partial name. Returns id, name, path, size, lastModified. Filters to .xlsx by default; set only_xlsx=false to see other files. Empty query returns recent files.',
    inputSchema: {
      query: z.string().describe('Substring of the file name to find. Empty string returns recent files.'),
      only_xlsx: z.boolean().optional().describe('If true (default), only .xlsx workbooks are returned.'),
      max_results: z.number().int().min(1).max(50).optional(),
    },
  }, async ({ query, only_xlsx, max_results }) => {
    const onlyXlsx = only_xlsx !== false;
    const top = max_results || 25;
    const q = String(query || '').trim();
    const endpoint = q
      ? `/me/drive/root/search(q='${encodeURIComponent(q)}')`
      : `/me/drive/recent`;
    const data = await graph('GET', endpoint, {
      query: {
        '$select': 'id,name,size,parentReference,lastModifiedDateTime,file',
        '$top': String(top * (onlyXlsx ? 3 : 1)),
      },
    });
    let items = (data.value || [])
      .filter((it) => it.file)
      .map((it) => ({
        id: it.id,
        name: it.name,
        path: (it.parentReference?.path || '').replace(/^\/drive\/root:/, '') + '/' + it.name,
        size: it.size,
        lastModified: it.lastModifiedDateTime,
      }));
    if (onlyXlsx) items = items.filter((it) => /\.xlsx$/i.test(it.name));
    return textResult(items.slice(0, top));
  });

  server.registerTool('list_folder', {
    title: 'List a folder in OneDrive',
    description: 'List contents (files and subfolders) of a OneDrive folder. Use this to explore the drive when search_files returns nothing. Pass empty path "" or "/" for the root folder. Returns id, name, type, size, lastModified.',
    inputSchema: {
      path: z.string().describe('Absolute path like "/Documents", "/Documents/Финансы", or empty/"/" for root.'),
    },
  }, async ({ path }) => {
    const p = String(path || '').trim().replace(/^\/+|\/+$/g, '');
    const endpoint = p
      ? `/me/drive/root:/${p.split('/').map(encodeURIComponent).join('/')}:/children`
      : `/me/drive/root/children`;
    const data = await graph('GET', endpoint, {
      query: { '$select': 'id,name,size,file,folder,lastModifiedDateTime' },
    });
    const items = (data.value || []).map((it) => ({
      id: it.id,
      name: it.name,
      type: it.folder ? 'folder' : 'file',
      size: it.size,
      lastModified: it.lastModifiedDateTime,
    }));
    return textResult(items);
  });

  // -- Workbook structure --------------------------------------------------

  server.registerTool('get_workbook_info', {
    title: 'Get metadata for an Excel workbook',
    description: 'Returns the workbook\'s name, size, web URL, last modified time, and the list of all worksheets. Call this as the first step after picking a specific Excel file — it gives the AI the structure needed to read/write intelligently.',
    inputSchema: {
      file: z.string().describe('Workbook reference — either an OneDrive item ID (e.g. "1F93...!s..."), or an absolute path like "/Documents/budget.xlsx".'),
    },
  }, async ({ file }) => {
    const base = workbookBase(file);
    const [meta, sheets] = await Promise.all([
      graph('GET', base, { query: { '$select': 'id,name,size,webUrl,lastModifiedDateTime' } }),
      graph('GET', `${base}/workbook/worksheets`, { query: { '$select': 'name,position,visibility' } }),
    ]);
    return textResult({
      id: meta.id,
      name: meta.name,
      size: meta.size,
      webUrl: meta.webUrl,
      lastModified: meta.lastModifiedDateTime,
      worksheets: sheets.value,
    });
  });

  server.registerTool('list_sheets', {
    title: 'List worksheets in a workbook',
    description: 'Return name, position, visibility for every worksheet in the given workbook. Sheet names can include Cyrillic or emojis — use them verbatim in subsequent calls.',
    inputSchema: {
      file: z.string().describe('Workbook item ID or absolute path.'),
    },
  }, async ({ file }) => {
    const data = await graph('GET', `${workbookBase(file)}/workbook/worksheets`, {
      query: { '$select': 'name,position,visibility' },
    });
    return textResult(data.value);
  });

  server.registerTool('used_range', {
    title: 'Get the data-filled range of a sheet',
    description: 'Return address (e.g. "Sheet1!A1:F47"), rowCount, columnCount of the non-empty area. Cheap and accurate — use it to find where data ends before appending, or to size up the sheet before reading.',
    inputSchema: {
      file: z.string(),
      sheet: z.string(),
    },
  }, async ({ file, sheet }) => {
    const data = await graph('GET', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/usedRange(valuesOnly=true)`, {
      query: { '$select': 'address,rowCount,columnCount' },
    });
    return textResult(data);
  });

  // -- Read ----------------------------------------------------------------

  server.registerTool('read_range', {
    title: 'Read cell values from a sheet range',
    description: 'Return values from any A1-style range. Result includes address, rowCount, columnCount, values (2D array of cells). Empty cells appear as "". Set include_formulas=true to additionally get the underlying formulas.',
    inputSchema: {
      file: z.string(),
      sheet: z.string(),
      range: z.string().describe('A1-style range like "A1:F20", "B3:B100", "A1:Z200".'),
      include_formulas: z.boolean().optional(),
    },
  }, async ({ file, sheet, range, include_formulas }) => {
    const select = include_formulas
      ? 'address,rowCount,columnCount,values,formulas'
      : 'address,rowCount,columnCount,values';
    const data = await graph('GET', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/range(address='${range}')`, {
      query: { '$select': select },
    });
    return textResult({
      address: data.address,
      rowCount: data.rowCount,
      columnCount: data.columnCount,
      values: data.values,
      ...(include_formulas ? { formulas: data.formulas } : {}),
    });
  });

  server.registerTool('search_rows', {
    title: 'Find rows in a sheet by column substring match',
    description: 'Read the sheet and return rows where the chosen column contains the query string (case-insensitive). Returns up to max_rows matches with their absolute row numbers. Good for "find all rows mentioning X" type questions.',
    inputSchema: {
      file: z.string(),
      sheet: z.string(),
      column_letter: z.string().describe('Excel column letter to scan, e.g. "A", "B", "C".'),
      query: z.string().describe('Substring (case-insensitive, Cyrillic OK) to match.'),
      max_rows: z.number().int().min(1).max(50).optional(),
    },
  }, async ({ file, sheet, column_letter, query, max_rows }) => {
    const used = await graph('GET', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/usedRange(valuesOnly=true)`, {
      query: { '$select': 'address,values,rowCount,columnCount' },
    });
    const m = String(used.address || '').match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    const startRow = m ? parseInt(m[2], 10) : 1;
    const colIdx = column_letter.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
    const q = String(query).toLowerCase();
    const matches = [];
    (used.values || []).forEach((row, i) => {
      const cell = String(row[colIdx] ?? '').toLowerCase();
      if (cell.includes(q)) matches.push({ row_number: startRow + i, values: row });
    });
    const limit = max_rows ?? 50;
    return textResult({
      total_matches: matches.length,
      returned: Math.min(matches.length, limit),
      rows: matches.slice(0, limit),
    });
  });

  // -- Write ---------------------------------------------------------------

  server.registerTool('update_range', {
    title: 'Write values to a specific range',
    description: 'Overwrite cells in the given range with a 2D array. Shape MUST match: outer length = rows, inner length = columns. Examples: single cell C5=42 → range="C5:C5", values=[[42]]; one full row of 5 columns → range="A47:E47", values=[["2026-05-27","Аренда","Расход",50000,"тг"]]. Read first if unsure; this overwrites silently.',
    inputSchema: {
      file: z.string(),
      sheet: z.string(),
      range: z.string(),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    },
  }, async ({ file, sheet, range, values }) => {
    const data = await graph('PATCH', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/range(address='${range}')`, {
      body: { values },
    });
    return textResult({ ok: true, updated: data.address, rowCount: data.rowCount, columnCount: data.columnCount });
  });

  server.registerTool('append_row', {
    title: 'Append a row at the end of a sheet',
    description: 'Find the first empty row after existing data and write the given row of values there. Uses usedRange to locate the bottom automatically. Useful for adding a new transaction, log entry, or line item.',
    inputSchema: {
      file: z.string(),
      sheet: z.string(),
      values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Single row of cell values to append. Length should match the existing data column count.'),
    },
  }, async ({ file, sheet, values }) => {
    const used = await graph('GET', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/usedRange(valuesOnly=true)`, {
      query: { '$select': 'address,rowCount,columnCount' },
    });
    const m = String(used.address || '').match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    const lastRow = m ? parseInt(m[4], 10) : (used.rowCount || 0);
    const startRow = lastRow + 1;
    const endCol = String.fromCharCode('A'.charCodeAt(0) + values.length - 1);
    const targetRange = `A${startRow}:${endCol}${startRow}`;
    const data = await graph('PATCH', `${workbookBase(file)}/workbook/worksheets('${encodeURIComponent(sheet)}')/range(address='${targetRange}')`, {
      body: { values: [values] },
    });
    return textResult({ ok: true, appended_at: data.address });
  });

  server.registerTool('create_sheet', {
    title: 'Create a new worksheet in a workbook',
    description: 'Add a new empty worksheet to the workbook with the given name. Useful when the user asks to start a new tab for a new category, month, or report.',
    inputSchema: {
      file: z.string(),
      name: z.string().describe('Name of the new worksheet. Must be unique within the workbook.'),
    },
  }, async ({ file, name }) => {
    const data = await graph('POST', `${workbookBase(file)}/workbook/worksheets/add`, { body: { name } });
    return textResult({ ok: true, name: data.name, position: data.position, id: data.id });
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------
async function main() {
  await loadBootstrap();
  await refreshAccessToken(); // sanity check on boot

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'mcp-excel' }));

  // -------------------------------------------------------------------------
  // OAuth 2.0 authorization server (single-client, single-user mode)
  //
  // Claude.ai's Custom Connector authenticates against us via OAuth 2.0
  // authorization-code flow. We accept the auth request, auto-approve it,
  // and redirect back to Claude.ai with a short-lived authorization code.
  // The /token endpoint then trades that code (plus client_secret) for an
  // access_token used on every MCP request.
  // -------------------------------------------------------------------------

  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are required.');
  }

  const authCodes = new Map(); // code -> { redirect_uri, code_challenge?, code_challenge_method?, expires_at }
  const accessTokens = new Map(); // token -> { expires_at }
  const refreshTokens = new Map(); // refresh -> {}

  function constantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  // OAuth 2.0 server metadata (RFC 8414). Clients may use either the bare
  // path (`/.well-known/oauth-authorization-server`) or the issuer-aware
  // suffix form (`/.well-known/oauth-authorization-server/<resource-path>`,
  // RFC 8414 §3.1). OpenID Connect discovery (`/.well-known/openid-
  // configuration[/<suffix>]`) gets the same response — Claude.ai probes
  // it as part of the same handshake.
  const authServerMeta = {
    issuer: PUBLIC_BASE_URL,
    authorization_endpoint: `${PUBLIC_BASE_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_BASE_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['excel'],
  };
  const protectedResourceMeta = {
    resource: PUBLIC_BASE_URL,
    authorization_servers: [PUBLIC_BASE_URL],
    bearer_methods_supported: ['header'],
    scopes_supported: ['excel'],
  };

  const sendAuthMeta = (_req, res) => res.json(authServerMeta);
  const sendProtRes = (_req, res) => res.json(protectedResourceMeta);

  app.get('/.well-known/oauth-authorization-server', sendAuthMeta);
  app.get('/.well-known/oauth-authorization-server/*', sendAuthMeta);
  app.get('/.well-known/openid-configuration', sendAuthMeta);
  app.get('/.well-known/openid-configuration/*', sendAuthMeta);
  app.get('/.well-known/oauth-protected-resource', sendProtRes);
  app.get('/.well-known/oauth-protected-resource/*', sendProtRes);

  // Dynamic Client Registration (RFC 7591). Single-client server, so we
  // always return the same statically configured credentials regardless of
  // what the client requests — Claude.ai will treat it as a successful DCR
  // and use these as its client_id/secret.
  app.post('/oauth/register', (req, res) => {
    res.status(201).json({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: req.body?.redirect_uris || [],
      scope: 'excel',
    });
  });

  function handleAuthorize(req, res) {
    // Accept params from query (GET) or body (POST).
    const src = req.method === 'POST' ? { ...req.body, ...req.query } : req.query;
    const { client_id, redirect_uri, state, response_type, code_challenge, code_challenge_method, scope } = src;
    if (response_type !== 'code') {
      return res.status(400).send('unsupported_response_type');
    }
    if (client_id !== OAUTH_CLIENT_ID) {
      return res.status(400).send('invalid_client');
    }
    if (!redirect_uri) {
      return res.status(400).send('missing redirect_uri');
    }
    // Auto-approve: single-user server, no consent UI needed.
    const code = randomUUID();
    authCodes.set(code, {
      redirect_uri: String(redirect_uri),
      code_challenge: code_challenge ? String(code_challenge) : null,
      code_challenge_method: code_challenge_method ? String(code_challenge_method) : null,
      expires_at: Date.now() + 5 * 60 * 1000,
    });
    const redirect = new URL(String(redirect_uri));
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', String(state));
    res.redirect(302, redirect.toString());
  }
  app.get('/oauth/authorize', handleAuthorize);
  app.post('/oauth/authorize', handleAuthorize);

  app.post('/oauth/token', (req, res) => {
    // Client auth can be in body or Authorization: Basic header.
    let { client_id, client_secret, grant_type, code, redirect_uri, code_verifier, refresh_token } = req.body || {};
    const basic = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (basic) {
      try {
        const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
        client_id = client_id || u;
        client_secret = client_secret || p;
      } catch (_) { /* ignore */ }
    }
    if (!constantTimeEq(String(client_id || ''), OAUTH_CLIENT_ID)) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    if (grant_type === 'authorization_code') {
      const entry = authCodes.get(code);
      if (!entry || entry.expires_at < Date.now()) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' });
      }
      if (entry.redirect_uri !== String(redirect_uri || '')) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      // PKCE if challenge was set; client_secret otherwise.
      if (entry.code_challenge) {
        if (!code_verifier) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
        }
        const method = (entry.code_challenge_method || 'plain').toUpperCase();
        let derived;
        if (method === 'S256') {
          derived = createHash('sha256').update(String(code_verifier)).digest('base64')
            .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        } else {
          derived = String(code_verifier);
        }
        if (!constantTimeEq(derived, entry.code_challenge)) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      } else {
        if (!constantTimeEq(String(client_secret || ''), OAUTH_CLIENT_SECRET)) {
          return res.status(401).json({ error: 'invalid_client' });
        }
      }
      authCodes.delete(code);
      const access = randomUUID() + randomUUID();
      const refresh = randomUUID() + randomUUID();
      accessTokens.set(access, { expires_at: Date.now() + 3600 * 1000 });
      refreshTokens.set(refresh, {});
      return res.json({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh,
        scope: 'excel',
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refreshTokens.has(refresh_token)) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (!constantTimeEq(String(client_secret || ''), OAUTH_CLIENT_SECRET)) {
        return res.status(401).json({ error: 'invalid_client' });
      }
      const access = randomUUID() + randomUUID();
      accessTokens.set(access, { expires_at: Date.now() + 3600 * 1000 });
      return res.json({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'excel',
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  function requireAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m && accessTokens.get(m[1]);
    if (!token || token.expires_at < Date.now()) {
      res.set('WWW-Authenticate', `Bearer realm="mcp-excel", error="invalid_token"`);
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: missing or expired access token.' },
        id: null,
      });
    }
    next();
  }

  const transports = new Map();

  const mcpHandler = async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId && transports.get(sessionId);

      if (!transport) {
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => transports.set(id, transport),
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          const server = buildServer();
          await server.connect(transport);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'No active session. Send an initialize request first.' },
            id: null,
          });
          return;
        }
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: String(err?.message || err) },
          id: null,
        });
      }
    }
  };

  app.post('/', requireAuth, mcpHandler);
  app.get('/', requireAuth, mcpHandler);
  app.delete('/', requireAuth, mcpHandler);

  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`mcp-excel listening on :${port}`);
    console.log('tools: search_files, list_folder, get_workbook_info, list_sheets, used_range, read_range, search_rows, update_range, append_row, create_sheet');
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
