# homey-mcp-worker

MCP (Model Context Protocol) server vystavující Homey Pro 2023 API jako nástroje pro Claude.ai.

Nahrazuje cestu `Já → Chrome extension → Chrome tab → localStorage → fetch → Homey` přímou cestou `Já → Worker → Homey`.

## Stack

- **Cloudflare Worker** (zdarma do 100k req/den)
- **TypeScript**, žádný framework — minimální závislosti
- **MCP protokol** (JSON-RPC 2.0 over HTTP, verze 2024-11-05) implementován ručně
- **Auth**: statický bearer token

## Nástroje (15)

| Tool | Co dělá |
|---|---|
| `homey_list_devices(filter?)` | Seznam zařízení s capabilities |
| `homey_get_device(id)` | Detail zařízení |
| `homey_set_capability(deviceId, capabilityId, value)` | Změna capability |
| `homey_list_logic_variables()` | Seznam Logic variables |
| `homey_get_logic_variable(name)` | Hodnota proměnné |
| `homey_set_logic_variable(name, value)` | Nastavit hodnotu |
| `homey_list_flows(folder?, search?, onlyEnabled?)` | Seznam flowů |
| `homey_get_flow(id)` | Detail flowu (trigger/conditions/actions) |
| `homey_trigger_flow(id)` | Manuálně spustit flow |
| `homey_set_flow_enabled(id, enabled)` | Enable/disable flow |
| `homey_list_scripts()` | Seznam HomeyScriptů |
| `homey_get_script(id)` | Skript + kód |
| `homey_run_script(id)` | Spustit skript |
| `homey_save_script(id, name, code)` | Update kódu |
| `homey_create_script(name, code)` | Nový skript |

## Setup (web-only, bez CLI)

### 1. GitHub repo

1. Otevři https://github.com/new
2. Repository name: `homey-mcp-worker`
3. Owner: LiorD78
4. Public (CF má potíž s privátními při connect)
5. Init: prázdný, žádný README ani .gitignore (přidá Claude)
6. **Create repository**

Pak nahraj soubory přes GitHub web UI (Add file → Upload files), které ti Claude dodá.

### 2. Cloudflare Worker

1. https://dash.cloudflare.com → Workers & Pages
2. **Create** → **Connect to Git**
3. Vybrat `homey-mcp-worker` repo
4. Build settings: nech default (CF detekuje `wrangler.toml`)
5. **Save and Deploy**

### 3. Secrets

V dashboardu workeru: Settings → Variables → Encrypted Variables:

- `HOMEY_TOKEN` = hodnota Homey Logic var `homey_api_token` (Personal Access Token, ID `7c1647c3-e3bf-40b3-b031-418da8da53dd`)
- `MCP_BEARER` = náhodný 32+ znaků string (jen pro tento konektor)

### 4. URL workeru

Po deploymentu CF zobrazí URL, něco jako `https://homey-mcp-worker.<subdomain>.workers.dev`.

Test:
```bash
curl https://homey-mcp-worker.<subdomain>.workers.dev/
# {"ok":true,"server":{...},"toolCount":15}
```

### 5. Připojení v Claude.ai

1. https://claude.ai → Settings → Connectors → Add custom connector
2. Server URL: `https://homey-mcp-worker.<subdomain>.workers.dev/mcp`
3. Authorization header: `Bearer <MCP_BEARER>`
4. **Save**

V chatu by se měly objevit nástroje `homey_*`.

## Bezpečnost

- `HOMEY_TOKEN` je v CF jako encrypted secret, neopouští Worker
- `MCP_BEARER` ho chrání před cizími přístupy
- Worker je dosažitelný jen přes HTTPS
- Tokenem disponuje pouze CF infrastruktura — Anthropic ho má jen jako string v config konektoru, neposílá ho do promptu

## Otazníky

- **Rate limiting**: Worker free tier má 100k req/den. Pro jeden konektor naprosto bohatě.
- **Cold start**: ~50ms při neaktivitě, jinak ~10-30ms latence + Homey API ~200-500ms
- **Token expiry**: Homey PAT vyprší podle nastavení (full scope, žádný expiry). Pokud expiroval, vygeneruj nový v Homey a aktualizuj CF secret.

## Vývoj

Pokud chceš upravovat lokálně:
```bash
npm install
wrangler login
wrangler dev      # lokální server
wrangler deploy   # ruční deploy (alternativa k Git connect)
```
