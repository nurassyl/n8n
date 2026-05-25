# Runbook: credentials setup

Step-by-step for the OAuth apps and API keys this deployment uses.

> All n8n OAuth callback URLs follow the pattern:
> `https://n8n.nurassyl.com/rest/oauth2-credential/callback`
>
> **Use `contact@nurassyl.com`** as the registering email for every third-party
> account below (Azure AD, Notion, Anthropic, OpenAI, etc.) — this is the
> single canonical email for the entire deployment.

---

## 1. Microsoft 365 — Excel & OneDrive (Microsoft Graph)

Used by the **Microsoft Excel 365** and **Microsoft OneDrive** nodes.

### Register Azure AD app

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `n8n.nurassyl.com`.
3. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (unless restricted).
4. Redirect URI: **Web** → `https://n8n.nurassyl.com/rest/oauth2-credential/callback`
5. Register.

### API permissions

In the new app → **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**. Add:

- `offline_access` (for refresh tokens — important!)
- `User.Read`
- `Files.ReadWrite` (OneDrive personal/business)
- `Files.ReadWrite.All` (read/write any file user can access)
- `Sites.ReadWrite.All` (if Excel files live in SharePoint sites)

Grant admin consent if you have a tenant.

### Client secret

**Certificates & secrets** → **New client secret** → expires 24 months → copy
the **Value** (not the ID).

### Wire in n8n

n8n → **Credentials** → **Create New** → search **Microsoft Excel OAuth2 API**
(and separately **Microsoft OneDrive OAuth2 API**, they share settings):

| Field          | Value                                                           |
|----------------|-----------------------------------------------------------------|
| Client ID      | (from app overview — "Application (client) ID")                 |
| Client Secret  | (the secret Value)                                              |
| Authorization URL | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` |
| Access Token URL  | `https://login.microsoftonline.com/common/oauth2/v2.0/token`     |
| Scope          | `offline_access Files.ReadWrite Files.ReadWrite.All User.Read`  |

Click **Connect my account** → Microsoft login → consent screen → back to n8n.

---

## 2. Notion — internal integration

1. <https://www.notion.so/profile/integrations> → **+ New integration**.
2. Type: **Internal**. Workspace: your workspace. Name: `n8n`.
3. Capabilities: read/update/insert content, read user info, **no comments**
   unless you need them. Read content limits — full access.
4. Copy the **Internal Integration Secret** (starts `ntn_…`).

### Share databases with the integration

Each Notion database the workflow touches must be shared with the integration:
open the database page → top-right **…** → **Connections** → search "n8n" →
allow.

### Wire in n8n

n8n → Credentials → **Notion API**:

| Field         | Value                          |
|---------------|--------------------------------|
| API Key       | the `ntn_…` secret             |

---

## 3. Anthropic (Claude) — optional for in-workflow LLM nodes

1. <https://console.anthropic.com/> → **API Keys** → **Create Key**.
2. Name: `n8n.nurassyl.com`.
3. Copy `sk-ant-…`.

n8n → Credentials → **Anthropic API**:

| Field   | Value      |
|---------|------------|
| API Key | `sk-ant-…` |

Default model in workflows: `claude-opus-4-7` (or `claude-sonnet-4-6` for
cheaper/faster).

---

## 4. OpenAI — optional

1. <https://platform.openai.com/api-keys> → **Create new secret key**.
2. Restrict scope as you wish.

n8n → Credentials → **OpenAI API**: paste the key.

---

## 5. MCP exposure (Claude.ai / ChatGPT Custom Connectors)

n8n exposes MCP via the **MCP Server Trigger** node. The flow:

1. In n8n → New workflow → first node: **MCP Server Trigger**.
2. n8n shows a public URL like:
   `https://n8n.nurassyl.com/mcp/<random-id>/sse`
3. Add tool nodes (e.g. "Read Excel range", "Append row", "Query Notion") as
   children of the trigger — each becomes a callable MCP tool.
4. Activate workflow.

### Register in Claude.ai

Claude.ai → **Settings** → **Connectors** → **Add custom connector** →
**Remote (MCP)** → paste the URL → authenticate. For private connectors you
typically pair this with the **header auth** option in n8n's MCP trigger
(generate a long random token, paste it in both n8n and Claude's connector
config).

### Register in ChatGPT

Custom GPT → Configure → Actions → import OpenAPI, or use ChatGPT's MCP
connector flow (Pro plan). Same URL + token.

---

## Security checklist

- [ ] `.env` is `chmod 600` and not in git
- [ ] `N8N_ENCRYPTION_KEY` backed up out-of-band
- [ ] MCP trigger uses header-token auth, not anonymous
- [ ] Azure AD app secret rotation reminder set (24-month default)
- [ ] Anthropic / OpenAI keys are workspace-scoped or low-quota for safety
