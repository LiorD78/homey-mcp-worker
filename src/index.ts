/**
 * Homey MCP Worker
 *
 * Exposes Homey Pro 2023 API as MCP tools accessible via Claude.ai custom connector.
 *
 * Endpoints:
 *   GET  /        — health check
 *   POST /mcp     — MCP JSON-RPC endpoint (used by Claude.ai)
 *
 * Auth: Authorization: Bearer <MCP_BEARER>
 *   (tolerant: "Bearer " prefix optional, case-insensitive, surrounding whitespace ignored)
 *
 * Deployments (same code):
 *   - homey-mcp-worker      — home Homey (default env)
 *   - homey-tdt-mcp-worker  — work Homey TDT (wrangler deploy --env tdt)
 *
 * Tools provided:
 *   - homey_list_devices(filter?)
 *   - homey_get_device(id)
 *   - homey_set_capability(deviceId, capabilityId, value)
 *   - homey_list_logic_variables()
 *   - homey_get_logic_variable(name)
 *   - homey_set_logic_variable(name, value)
 *   - homey_list_flows(folder?, search?)
 *   - homey_get_flow(id)
 *   - homey_trigger_flow(id)
 *   - homey_set_flow_enabled(id, enabled)
 *   - homey_list_scripts()
 *   - homey_get_script(id)
 *   - homey_run_script(id)
 *   - homey_save_script(id, code) — UPDATE existing script
 *   - homey_create_script(name, code)
 */

interface Env {
  HOMEY_CLOUD_ID: string;
  HOMEY_TOKEN: string;
  MCP_BEARER: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// -------------------------- Homey API helpers --------------------------

function homeyBase(env: Env): string {
  return `https://${env.HOMEY_CLOUD_ID}.connect.athom.com/api`;
}

async function homey<T = any>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${homeyBase(env)}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.HOMEY_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Homey ${init.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  // Some endpoints return 204 No Content
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// Pick only fields useful for AI reasoning (devices have huge raw payloads)
function summarizeDevice(d: any) {
  if (!d) return null;
  const caps: Record<string, any> = {};
  if (d.capabilitiesObj) {
    for (const [k, v] of Object.entries<any>(d.capabilitiesObj)) {
      caps[k] = v?.value;
    }
  }
  return {
    id: d.id,
    name: d.name,
    zone: d.zone,
    driverUri: d.driverUri,
    available: d.available,
    capabilities: caps,
  };
}

// -------------------------- Tools --------------------------

type ToolHandler = (env: Env, args: any) => Promise<any>;

const tools: Record<string, { description: string; inputSchema: any; handler: ToolHandler }> = {
  homey_list_devices: {
    description: 'List all Homey devices. Optional substring filter on device name.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Case-insensitive substring of device name to filter by' },
      },
    },
    handler: async (env, { filter }) => {
      const all = await homey<Record<string, any>>(env, '/manager/devices/device');
      const list = Object.values(all).map(summarizeDevice);
      if (!filter) return list;
      const f = String(filter).toLowerCase();
      return list.filter((d: any) => (d.name || '').toLowerCase().includes(f));
    },
  },

  homey_get_device: {
    description: 'Get detailed state of a single device by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Device UUID' } },
    },
    handler: async (env, { id }) => {
      const d = await homey(env, `/manager/devices/device/${id}`);
      return summarizeDevice(d);
    },
  },

  homey_set_capability: {
    description: 'Set a capability value on a device (e.g. windowcoverings_state=down, onoff=true).',
    inputSchema: {
      type: 'object',
      required: ['deviceId', 'capabilityId', 'value'],
      properties: {
        deviceId: { type: 'string' },
        capabilityId: { type: 'string', description: 'e.g. windowcoverings_state, onoff, target_temperature' },
        value: { description: 'New value (string, number, or boolean depending on capability)' },
      },
    },
    handler: async (env, { deviceId, capabilityId, value }) => {
      const r = await homey(env, `/manager/devices/device/${deviceId}/capability/${capabilityId}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      return r;
    },
  },

  homey_list_logic_variables: {
    description: 'List all Homey Logic variables (name, type, value).',
    inputSchema: { type: 'object', properties: {} },
    handler: async (env) => {
      const all = await homey<Record<string, any>>(env, '/manager/logic/variable');
      return Object.values(all).map((v: any) => ({ id: v.id, name: v.name, type: v.type, value: v.value }));
    },
  },

  homey_get_logic_variable: {
    description: 'Get a single Logic variable by name.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
    handler: async (env, { name }) => {
      const all = await homey<Record<string, any>>(env, '/manager/logic/variable');
      const v = Object.values(all).find((x: any) => x.name === name);
      if (!v) throw new Error(`Variable not found: ${name}`);
      return { id: v.id, name: v.name, type: v.type, value: v.value };
    },
  },

  homey_set_logic_variable: {
    description: 'Set value of an existing Logic variable by name.',
    inputSchema: {
      type: 'object',
      required: ['name', 'value'],
      properties: {
        name: { type: 'string' },
        value: { description: 'New value (type must match variable type)' },
      },
    },
    handler: async (env, { name, value }) => {
      const all = await homey<Record<string, any>>(env, '/manager/logic/variable');
      const v = Object.values(all).find((x: any) => x.name === name);
      if (!v) throw new Error(`Variable not found: ${name}`);
      const r = await homey(env, `/manager/logic/variable/${v.id}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      return r;
    },
  },

  homey_list_flows: {
    description: 'List Homey flows. Optional folder UUID filter and name substring search.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder UUID' },
        search: { type: 'string', description: 'Substring of flow name (case-insensitive)' },
        onlyEnabled: { type: 'boolean' },
      },
    },
    handler: async (env, { folder, search, onlyEnabled }) => {
      const all = await homey<Record<string, any>>(env, '/manager/flow/flow');
      let list: any[] = Object.values(all).map((f: any) => ({
        id: f.id, name: f.name, enabled: f.enabled, folder: f.folder,
        broken: f.broken, lastExecuted: f.lastExecuted,
      }));
      if (folder) list = list.filter(f => f.folder === folder);
      if (search) {
        const s = String(search).toLowerCase();
        list = list.filter(f => (f.name || '').toLowerCase().includes(s));
      }
      if (onlyEnabled) list = list.filter(f => f.enabled);
      return list;
    },
  },

  homey_get_flow: {
    description: 'Get full flow definition (trigger, conditions, actions).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    handler: async (env, { id }) => {
      return await homey(env, `/manager/flow/flow/${id}`);
    },
  },

  homey_trigger_flow: {
    description: 'Manually trigger a flow by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    handler: async (env, { id }) => {
      await homey(env, `/manager/flow/flow/${id}/trigger`, { method: 'POST', body: '{}' });
      return { ok: true };
    },
  },

  homey_set_flow_enabled: {
    description: 'Enable or disable a flow.',
    inputSchema: {
      type: 'object',
      required: ['id', 'enabled'],
      properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
    },
    handler: async (env, { id, enabled }) => {
      await homey(env, `/manager/flow/flow/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      return { ok: true };
    },
  },

  homey_list_scripts: {
    description: 'List all HomeyScripts (name, id, lastExecuted) — does NOT return code.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (env) => {
      const all = await homey<Record<string, any>>(env, '/app/com.athom.homeyscript/script');
      return Object.values(all).map((s: any) => ({
        id: s.id, name: s.name, lastExecuted: s.lastExecuted, version: s.version,
      }));
    },
  },

  homey_get_script: {
    description: 'Get a HomeyScript including its code.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    handler: async (env, { id }) => {
      return await homey(env, `/app/com.athom.homeyscript/script/${id}`);
    },
  },

  homey_run_script: {
    description: 'Run a HomeyScript by ID. Returns {success, returns?}.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    handler: async (env, { id }) => {
      return await homey(env, `/app/com.athom.homeyscript/script/${id}/run`, {
        method: 'POST',
        body: '{}',
      });
    },
  },

  homey_save_script: {
    description: 'Update an existing HomeyScript code by ID.',
    inputSchema: {
      type: 'object',
      required: ['id', 'name', 'code'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    handler: async (env, { id, name, code }) => {
      return await homey(env, `/app/com.athom.homeyscript/script/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, code }),
      });
    },
  },

  homey_create_script: {
    description: 'Create a new HomeyScript.',
    inputSchema: {
      type: 'object',
      required: ['name', 'code'],
      properties: {
        name: { type: 'string' },
        code: { type: 'string' },
      },
    },
    handler: async (env, { name, code }) => {
      return await homey(env, `/app/com.athom.homeyscript/script`, {
        method: 'POST',
        body: JSON.stringify({ name, code }),
      });
    },
  },
};

// -------------------------- MCP JSON-RPC handling --------------------------

const SERVER_INFO = {
  name: 'homey-mcp-worker',
  version: '0.1.1',
};

const PROTOCOL_VERSION = '2024-11-05';

async function handleMcp(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };

      case 'notifications/initialized':
      case 'initialized':
        // Notification, but be permissive — return empty result
        return { jsonrpc: '2.0', id, result: {} };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: Object.entries(tools).map(([name, t]) => ({
              name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case 'tools/call': {
        const { name, arguments: args } = req.params || {};
        const tool = tools[name];
        if (!tool) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
        }
        try {
          const result = await tool.handler(env, args || {});
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          };
        } catch (e: any) {
          return {
            jsonrpc: '2.0', id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
            },
          };
        }
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  } catch (e: any) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message || String(e) } };
  }
}

// -------------------------- Auth --------------------------

// Accepts "Bearer <secret>", "bearer <secret>" or just "<secret>"; ignores surrounding whitespace/newlines.
function checkAuth(request: Request, env: Env): { ok: boolean; diag: Record<string, any> } {
  const raw = (request.headers.get('Authorization') || '').trim();
  const hasPrefix = /^bearer\s+/i.test(raw);
  const token = raw.replace(/^bearer\s+/i, '').trim();
  const secret = (env.MCP_BEARER || '').trim();
  const ok = token.length > 0 && token === secret;
  // Diagnostic only — never logs the secret or the presented token.
  const diag = {
    hasHeader: raw.length > 0,
    bearerPrefix: hasPrefix,
    presentedLen: token.length,
    expectedLen: secret.length,
    sameFirstChar: token.length > 0 && secret.length > 0 && token[0] === secret[0],
    sameLastChar: token.length > 0 && secret.length > 0 && token[token.length - 1] === secret[secret.length - 1],
  };
  return { ok, diag };
}

// -------------------------- Worker entrypoint --------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        server: SERVER_INFO,
        toolCount: Object.keys(tools).length,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    // Auth
    if (!env.MCP_BEARER) {
      return new Response('Server misconfigured: MCP_BEARER not set', { status: 500 });
    }
    const auth = checkAuth(request, env);
    if (!auth.ok) {
      console.log(JSON.stringify({ auth: 'fail', ...auth.diag }));
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body: JsonRpcRequest;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const response = await handleMcp(body, env);
    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
