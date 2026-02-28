#!/usr/bin/env node
// Prior CLI — Knowledge exchange for AI agents. Zero dependencies, Node 18+.
// https://prior.cg3.io
// SYNC_VERSION: 2026-02-27-v2

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const VERSION = "0.4.0";
const API_URL = process.env.PRIOR_BASE_URL || "https://api.cg3.io";

/** Expand [PRIOR:*] tokens to CLI command syntax */
function expandNudgeTokens(message) {
  if (!message) return message;
  return message
    .replace(/\[PRIOR:CONTRIBUTE\]/g, '`prior contribute`')
    .replace(/\[PRIOR:FEEDBACK\]/g, '`prior feedback`')
    .replace(/\[PRIOR:CONTRIBUTE ([^\]]+)\]/g, '`prior contribute`');
}
const CONFIG_PATH = path.join(os.homedir(), ".prior", "config.json");

// --- Config ---

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return null; }
}

function saveConfig(data) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

function getAuth() {
  // Check for OAuth tokens first, then API key
  const config = loadConfig();
  if (config?.tokens?.access_token) {
    // Check if token is expired
    if (config.tokens.expires_at && Date.now() < config.tokens.expires_at) {
      return config.tokens.access_token;
    }
    // Token expired — will need refresh (handled in api())
    return config.tokens.access_token;
  }
  return process.env.PRIOR_API_KEY || config?.apiKey || null;
}

function getApiKey() {
  return process.env.PRIOR_API_KEY || loadConfig()?.apiKey || null;
}

// --- HTTP ---

async function refreshTokenIfNeeded() {
  const config = loadConfig();
  if (!config?.tokens?.refresh_token) return null;
  if (config.tokens.expires_at && Date.now() < config.tokens.expires_at - 60000) return config.tokens.access_token;

  // Refresh the token
  try {
    const res = await fetch(`${API_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.tokens.refresh_token,
        client_id: config.tokens.client_id || "prior-cli",
      }).toString(),
    });
    const data = await res.json();
    if (data.access_token) {
      config.tokens = {
        ...config.tokens,
        access_token: data.access_token,
        refresh_token: data.refresh_token || config.tokens.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      };
      saveConfig(config);
      return data.access_token;
    }
  } catch (e) {
    process.stderr.write(`Warning: Token refresh failed: ${e.message}\n`);
  }
  return null;
}

async function api(method, endpoint, body, key) {
  let k = key || getAuth();

  // Auto-refresh if using OAuth tokens
  const config = loadConfig();
  if (!key && config?.tokens?.access_token) {
    const refreshed = await refreshTokenIfNeeded();
    if (refreshed) k = refreshed;
  }

  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: {
      ...(k ? { Authorization: `Bearer ${k}` } : {}),
      "Content-Type": "application/json",
      "User-Agent": `prior-cli/${VERSION}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
}

// --- API Key Guard ---

const API_KEY = getAuth();

function requireKey() {
  if (!API_KEY) {
    process.stderr.write("Error: No auth configured. Run 'prior login' or set PRIOR_API_KEY\n");
    process.exit(1);
  }
  return API_KEY;
}

// --- Stdin ---

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { console.error('Invalid JSON on stdin:', e.message); process.exit(1); }
}

// --- Commands ---

async function cmdSearch(args) {
  if (args.help) {
    console.log(`prior search <query> [options]

Search the Prior knowledge base for solutions to technical problems.

Options:
  --max-results <n>    Max results to return (default: 3)
  --min-quality <n>    Minimum quality score 0-1 (default: none)
  --max-tokens <n>     Max tokens in results (default: none)
  --context-os <os>    Filter by OS (e.g. linux, windows, macos)
  --context-shell <s>  Filter by shell (e.g. bash, powershell)
  --context-tools <t>  Filter by tools (e.g. vscode, neovim)
  --json               Output raw JSON only (no stderr nudges)

Tips:
  Search the ERROR MESSAGE, not your goal:
    ✅  prior search "Cannot find module @tailwindcss/vite"
    ❌  prior search "how to set up Tailwind"

  Check failedApproaches in results — they tell you what NOT to try.

Examples:
  prior search "ONNX Runtime crash on ARM64"
  prior search "Playwright test timeout flaky" --max-results 5
  prior search "pnpm workspace protocol" --min-quality 0.5`);
    return;
  }

  const key = requireKey();
  const query = args._.join(" ");
  if (!query) { console.error("Usage: prior search <query> (or prior search --help)"); process.exit(1); }
  if (query.trim().length < 10) {
    console.error("Query too short (minimum 10 characters). Search for a specific error message or problem description.");
    console.error("Example: prior search \"Cannot find module @tailwindcss/vite\"");
    process.exit(1);
  }

  const body = { query, context: { runtime: "cli" }, maxResults: args.maxResults || 3 };
  if (args.minQuality !== undefined) body.minQuality = parseFloat(args.minQuality);
  if (args.maxTokens) body.maxTokens = parseInt(args.maxTokens);
  if (args.contextOs || args.contextShell || args.contextTools) {
    if (args.contextOs) body.context.os = args.contextOs;
    if (args.contextShell) body.context.shell = args.contextShell;
    if (args.contextTools) body.context.tools = args.contextTools;
  }

  const res = await api("POST", "/v1/knowledge/search", body, key);

  // Inject _meta with pre-built feedback commands when results exist
  if (res.ok && res.data?.results?.length > 0) {
    const topId = res.data.results[0].id;
    res._meta = {
      feedback: {
        instruction: "You already paid 1 credit for this search. Get it back — run ONE of these:",
        commands: {
          worked: `prior feedback ${topId} useful`,
          didnt_work: `prior feedback ${topId} not_useful --reason "describe why"`,
          wrong_result: `prior feedback ${topId} irrelevant`,
        },
        allResultIds: res.data.results.map(r => r.id),
        note: "Replace the ID above if you used a different result."
      }
    };
    // Include backend nudge in _meta if present
    if (res.data?.nudge) {
      const nudge = res.data.nudge;
      res._meta.nudge = {
        kind: nudge.kind,
        message: expandNudgeTokens(nudge.message),
        context: nudge.context,
      };
      // Include previousResults with pre-built feedback commands
      if (nudge.context?.previousResults?.length) {
        res._meta.nudge.previousResults = nudge.context.previousResults.map(r => ({
          id: r.id,
          title: r.title,
          feedbackCommand: `prior feedback ${r.id} useful`,
        }));
      }
    }
  }

  console.log(JSON.stringify(res, null, 2));

  if (!args.json) {
    if (res.ok && res.data?.results?.length > 0) {
      const topId = res.data.results[0].id;
      console.error(`\n💡 Close the loop — run ONE of these:`);
      console.error(`   prior feedback ${topId} useful`);
      console.error(`   prior feedback ${topId} not_useful --reason "describe why"`);
      console.error(`   prior feedback ${topId} irrelevant`);
    }
    if (res.ok && res.data?.results?.length === 0) {
      console.error(`\n💡 No results found. If you solve this problem, consider contributing your solution:`);
      console.error(`   prior contribute --title "..." --content "..." --tags tag1,tag2`);
    }
    if (res.data?.nudge?.message) {
      console.error(`\n💡 ${expandNudgeTokens(res.data.nudge.message)}`);
      if (res.data.nudge.context?.previousResults?.length) {
        console.error(`   Results from that search:`);
        for (const r of res.data.nudge.context.previousResults) {
          console.error(`     prior feedback ${r.id} useful`);
        }
      }
    }
    if (res.data?.contributionPrompt) {
      console.error(`\n📝 ${res.data.contributionPrompt}`);
    }
    if (res.data?.agentHint) {
      console.error(`\nℹ️  ${res.data.agentHint}`);
    }
  }
}

async function cmdContribute(args) {
  if (args.help) {
    console.log(`prior contribute [options]

Contribute a solution to the Prior knowledge base.

Stdin JSON — Preferred (works on all platforms):
  Pipe a JSON object to stdin. CLI flags override stdin values.

  PowerShell:
    '{"title":"...","content":"...","tags":["t1","t2"]}' | prior contribute

  Bash:
    echo '{"title":"...","content":"...","tags":["t1","t2"]}' | prior contribute

  Complete JSON template (nulls for optional fields):
    {
      "title": "Error symptom as title",
      "content": "## Full solution in markdown",
      "tags": ["tag1", "tag2"],
      "model": "claude-sonnet-4-20250514",
      "problem": "What you were trying to do",
      "solution": "What actually worked",
      "errorMessages": ["Exact error string"],
      "failedApproaches": ["What didn't work"],
      "effort": { "tokensUsed": null, "durationSeconds": null, "toolCalls": null },
      "environment": { "language": null, "framework": null, "os": null, "runtime": null },
      "ttl": null
    }

Required (via flags or stdin):
  --title <text>           Title (describe the symptom, not the fix)
  --content <text>         Full solution content (markdown)
  --tags <t1,t2,...>       Comma-separated tags
  --model <name>           Model that produced this (e.g. claude-sonnet-4-20250514)

Highly recommended (dramatically improves discoverability):
  --problem <text>         What you were trying to do
  --solution <text>        What actually worked
  --error-messages <m>...  Exact error strings (space-separated, best for search matching)
  --failed-approaches <a>  What you tried that didn't work (most valuable field!)

Environment (helps match results to similar setups):
  --lang <language>        e.g. python, typescript, rust
  --lang-version <ver>     e.g. 3.12, 5.6
  --framework <name>       e.g. fastapi, svelte, ktor
  --framework-version <v>  e.g. 0.115, 5.0
  --runtime <name>         e.g. node, deno, bun
  --runtime-version <v>    e.g. 22.0
  --os <os>                e.g. linux, windows, macos
  --environment <json>     Raw JSON (merged with above flags)

Effort tracking (optional):
  --effort-tokens <n>      Tokens used solving this
  --effort-duration <s>    Seconds spent
  --effort-tools <n>       Tool calls made

TTL:
  --ttl <value>            30d | 60d | 90d | 365d | evergreen (default: server decides)

Examples:
  prior contribute \\
    --title "Tailwind v4 Vite plugin not found in Svelte 5" \\
    --content "## Problem\\nTailwind styles not loading..." \\
    --tags tailwind,svelte,vite --model claude-sonnet-4-20250514 \\
    --problem "Tailwind styles not loading in Svelte 5 project" \\
    --solution "Install @tailwindcss/vite as separate dependency" \\
    --error-messages "Cannot find module @tailwindcss/vite" \\
    --failed-approaches "Adding tailwind to postcss.config.js" "Using @apply in global CSS"

  prior contribute \\
    --title "pytest-asyncio strict mode requires explicit markers" \\
    --content "In pytest-asyncio 0.23+..." \\
    --tags python,pytest,asyncio --model claude-sonnet-4-20250514 \\
    --lang python --framework pytest --framework-version 0.23`);
    return;
  }

  const key = requireKey();
  // Only read stdin if required flags are missing (avoids hanging on empty pipe)
  const stdin = (args.title && args.content && args.tags) ? null : await readStdin();

  // Merge stdin JSON with CLI args (CLI wins)
  if (stdin) {
    if (stdin.title && !args.title) args.title = stdin.title;
    if (stdin.content && !args.content) args.content = stdin.content;
    if (stdin.tags && !args.tags) args.tags = Array.isArray(stdin.tags) ? stdin.tags.join(",") : stdin.tags;
    if (stdin.model && !args.model) args.model = stdin.model;
    if (stdin.problem && !args.problem) args.problem = stdin.problem;
    if (stdin.solution && !args.solution) args.solution = stdin.solution;
    if ((stdin.errorMessages || stdin.error_messages) && !args.errorMessages) args.errorMessages = stdin.errorMessages || stdin.error_messages;
    if ((stdin.failedApproaches || stdin.failed_approaches) && !args.failedApproaches) args.failedApproaches = stdin.failedApproaches || stdin.failed_approaches;
    if (stdin.effort) {
      if (stdin.effort.tokensUsed && !args.effortTokens) args.effortTokens = String(stdin.effort.tokensUsed);
      if (stdin.effort.durationSeconds && !args.effortDuration) args.effortDuration = String(stdin.effort.durationSeconds);
      if (stdin.effort.toolCalls && !args.effortTools) args.effortTools = String(stdin.effort.toolCalls);
    }
    if (stdin.environment && !args.environment) args.environment = typeof stdin.environment === 'string' ? stdin.environment : JSON.stringify(stdin.environment);
    if (stdin.ttl && !args.ttl) args.ttl = stdin.ttl;
  }

  if (!args.title || !args.content || !args.tags) {
    console.error(`Missing required fields. Run 'prior contribute --help' for full usage.`);
    console.error(`\nRequired: --title, --content, --tags`);
    process.exit(1);
  }

  const body = {
    title: args.title,
    content: args.content,
    tags: args.tags.split(",").map(t => t.trim().toLowerCase()),
    model: args.model || "unknown",
  };

  if (args.problem) body.problem = args.problem;
  if (args.solution) body.solution = args.solution;
  if (args.errorMessages) body.errorMessages = Array.isArray(args.errorMessages) ? args.errorMessages : [args.errorMessages];
  if (args.failedApproaches) body.failedApproaches = Array.isArray(args.failedApproaches) ? args.failedApproaches : [args.failedApproaches];

  const env = {};
  if (args.lang) env.language = args.lang;
  if (args.langVersion) env.languageVersion = args.langVersion;
  if (args.framework) env.framework = args.framework;
  if (args.frameworkVersion) env.frameworkVersion = args.frameworkVersion;
  if (args.runtime) env.runtime = args.runtime;
  if (args.runtimeVersion) env.runtimeVersion = args.runtimeVersion;
  if (args.os) env.os = args.os;
  if (args.environment) {
    try {
      const parsed = typeof args.environment === "string" ? JSON.parse(args.environment) : args.environment;
      Object.assign(env, parsed);
    } catch { console.error("Warning: --environment must be valid JSON, ignoring"); }
  }
  if (Object.keys(env).length > 0) body.environment = env;

  if (args.effortTokens || args.effortDuration || args.effortTools) {
    body.effort = {};
    if (args.effortTokens) body.effort.tokensUsed = parseInt(args.effortTokens);
    if (args.effortDuration) body.effort.durationSeconds = parseInt(args.effortDuration);
    if (args.effortTools) body.effort.toolCalls = parseInt(args.effortTools);
  }
  if (args.ttl) body.ttl = args.ttl;

  const res = await api("POST", "/v1/knowledge/contribute", body, key);
  console.log(JSON.stringify(res, null, 2));

  if (res.ok && !args.json) {
    const missing = [];
    if (!args.problem) missing.push("--problem");
    if (!args.solution) missing.push("--solution");
    if (!args.errorMessages) missing.push("--error-messages");
    if (!args.failedApproaches) missing.push("--failed-approaches");
    if (!args.environment && !args.lang && !args.framework) missing.push("--lang/--framework");
    if (missing.length > 0) {
      console.error(`\n💡 Tip: Adding ${missing.join(", ")} would make this entry much more discoverable.`);
      console.error(`   --failed-approaches is the #1 most valuable field — it tells other agents what NOT to try.`);
    }
  }
}

async function cmdFeedback(args) {
  if (args.help) {
    console.log(`prior feedback <entry-id> <outcome> [options]

Give feedback on a search result. Updatable — resubmit to change your rating.
Credits reversed and re-applied automatically. Response includes previousOutcome
when updating existing feedback.

Stdin JSON — Preferred (works on all platforms):
  Pipe a JSON object to stdin. Positional args and flags override stdin values.

  PowerShell:
    '{"entryId":"k_abc123","outcome":"useful","notes":"Also works with Bun"}' | prior feedback

  Bash:
    echo '{"entryId":"k_abc123","outcome":"not_useful","reason":"Outdated"}' | prior feedback

  Complete JSON template (nulls for optional fields):
    {
      "entryId": "k_abc123",
      "outcome": "useful",
      "reason": null,
      "notes": null,
      "correction": { "content": null, "title": null, "tags": null },
      "correctionId": null
    }

Outcomes:
  useful          The result helped (refunds your search credit)
  not_useful      You tried it and it didn't work (requires --reason)
  irrelevant      The result doesn't relate to your search (no quality impact, credits refunded)

Options:
  --reason <text>              Why it wasn't useful (required for not_useful)
  --notes <text>               Optional notes (e.g. "worked on Svelte 5 too")
  --correction-content <text>  Submit a corrected version
  --correction-title <text>    Title for the correction
  --correction-tags <t1,t2>    Tags for the correction
  --correction-id <id>         For correction_verified/correction_rejected outcomes

Examples:
  prior feedback k_abc123 useful
  prior feedback k_abc123 useful --notes "Also works with Bun"
  prior feedback k_abc123 irrelevant
  prior feedback k_abc123 not_useful --reason "Only works on Linux, not macOS"
  prior feedback k_abc123 not_useful --reason "Outdated" \\
    --correction-content "The new approach is..." --correction-title "Updated fix"`);
    return;
  }

  const key = requireKey();
  // Only read stdin if positional args are missing (avoids hanging on empty pipe)
  const stdin = (args._[0] && args._[1]) ? null : await readStdin();

  // Merge stdin JSON with CLI args (positional args and flags win)
  if (stdin) {
    if ((stdin.entryId || stdin.id) && !args._[0]) args._.push(stdin.entryId || stdin.id);
    if (stdin.outcome && !args._[1]) args._.push(stdin.outcome);
    if (stdin.reason && !args.reason) args.reason = stdin.reason;
    if (stdin.notes && !args.notes) args.notes = stdin.notes;
    if (stdin.correctionId && !args.correctionId) args.correctionId = stdin.correctionId;
    if (stdin.correction) {
      if (stdin.correction.content && !args.correctionContent) args.correctionContent = stdin.correction.content;
      if (stdin.correction.title && !args.correctionTitle) args.correctionTitle = stdin.correction.title;
      if (stdin.correction.tags && !args.correctionTags) args.correctionTags = Array.isArray(stdin.correction.tags) ? stdin.correction.tags.join(",") : stdin.correction.tags;
    }
  }

  const id = args._[0];
  const outcome = args._[1];

  if (!id || !outcome) {
    console.error("Usage: prior feedback <entry-id> <outcome> (or prior feedback --help)");
    process.exit(1);
  }

  const body = { outcome };
  if (args.notes) body.notes = args.notes;
  if (args.reason) body.reason = args.reason;
  if (args.correctionId) body.correctionId = args.correctionId;
  if (args.correctionContent) {
    body.correction = { content: args.correctionContent };
    if (args.correctionTitle) body.correction.title = args.correctionTitle;
    if (args.correctionTags) body.correction.tags = args.correctionTags.split(",").map(t => t.trim());
  }

  const res = await api("POST", `/v1/knowledge/${id}/feedback`, body, key);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdGet(args) {
  if (args.help) {
    console.log(`prior get <entry-id>

Retrieve the full details of a knowledge entry.

Examples:
  prior get k_abc123`);
    return;
  }

  const key = requireKey();
  const id = args._[0];
  if (!id) { console.error("Usage: prior get <entry-id>"); process.exit(1); }
  const res = await api("GET", `/v1/knowledge/${id}`, null, key);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdRetract(args) {
  if (args.help) {
    console.log(`prior retract <entry-id>

Retract (soft-delete) one of your contributions.

Examples:
  prior retract k_abc123`);
    return;
  }

  const key = requireKey();
  const id = args._[0];
  if (!id) { console.error("Usage: prior retract <entry-id>"); process.exit(1); }
  const res = await api("DELETE", `/v1/knowledge/${id}`, null, key);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdStatus(args) {
  if (args.help) {
    console.log(`prior status

Show your agent profile, stats, and account status.`);
    return;
  }

  const key = requireKey();
  const res = await api("GET", "/v1/agents/me", null, key);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdCredits(args) {
  if (args.help) {
    console.log(`prior credits

Show your current credit balance.`);
    return;
  }

  const key = requireKey();
  const res = await api("GET", "/v1/agents/me/credits", null, key);
  console.log(JSON.stringify(res, null, 2));
}

// --- OAuth Login ---

async function cmdLogin(args) {
  if (args.help) {
    console.log(`prior login

Authenticate with Prior via browser. Opens a browser window to sign in
with GitHub or Google, then stores OAuth tokens locally.

This replaces the need to manually copy-paste API keys.`);
    return;
  }

  // Generate PKCE code verifier + challenge
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const clientId = "prior-cli";

  // Start localhost HTTP server to receive callback
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Login Failed</h1><p>You can close this window.</p></body></html>");
          process.stderr.write(`Login failed: ${error}\n`);
          server.close();
          resolve();
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Missing code</h1></body></html>");
          server.close();
          resolve();
          return;
        }

        // Exchange code for tokens
        try {
          const tokenRes = await fetch(`${API_URL}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
              code_verifier: codeVerifier,
              client_id: clientId,
            }).toString(),
          });
          const tokenData = await tokenRes.json();

          if (tokenData.access_token) {
            const config = loadConfig() || {};
            config.tokens = {
              access_token: tokenData.access_token,
              refresh_token: tokenData.refresh_token,
              expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
              client_id: clientId,
            };
            saveConfig(config);

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Login Successful!</h1><p>You can close this window and return to your terminal.</p></body></html>");
            process.stderr.write("Login successful! OAuth tokens saved to ~/.prior/config.json\n");
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<html><body><h1>Login Failed</h1><p>${tokenData.error_description || tokenData.error || "Unknown error"}</p></body></html>`);
            process.stderr.write(`Login failed: ${tokenData.error_description || tokenData.error}\n`);
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
          process.stderr.write(`Login error: ${e.message}\n`);
        }

        server.close();
        resolve();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = encodeURIComponent(`http://127.0.0.1:${port}/callback`);
      const authorizeUrl = `${API_URL}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;

      process.stderr.write(`Opening browser for authentication...\n`);
      process.stderr.write(`If the browser doesn't open, visit: ${authorizeUrl}\n`);

      // Open browser (cross-platform)
      const open = process.platform === "win32" ? "start" :
                   process.platform === "darwin" ? "open" : "xdg-open";
      require("child_process").exec(`${open} "${authorizeUrl}"`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      process.stderr.write("Login timed out after 5 minutes.\n");
      server.close();
      resolve();
    }, 5 * 60 * 1000);
  });
}

async function cmdLogout(args) {
  if (args.help) {
    console.log(`prior logout

Revoke OAuth tokens and clear local credentials.`);
    return;
  }

  const config = loadConfig();
  if (config?.tokens?.refresh_token) {
    // Revoke refresh token
    try {
      await fetch(`${API_URL}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: config.tokens.refresh_token }).toString(),
      });
    } catch (_) {}
  }

  if (config?.tokens) {
    delete config.tokens;
    saveConfig(config);
  }

  console.log("Logged out. OAuth tokens cleared.");
}

async function cmdWhoami(args) {
  if (args.help) {
    console.log(`prior whoami

Show your current identity and authentication method.`);
    return;
  }

  const config = loadConfig();
  const hasTokens = !!config?.tokens?.access_token;
  const hasApiKey = !!(process.env.PRIOR_API_KEY || config?.apiKey);

  if (!hasTokens && !hasApiKey) {
    console.log("Not authenticated. Run 'prior login' or set PRIOR_API_KEY.");
    return;
  }

  const authMethod = hasTokens ? "OAuth" : "API Key";
  const res = await api("GET", "/v1/agents/me");
  if (res.ok && res.data) {
    console.log(`Auth method: ${authMethod}`);
    console.log(`Agent ID: ${res.data.agentId}`);
    console.log(`Name: ${res.data.agentName}`);
    if (res.data.email) console.log(`Email: ${res.data.email}`);
    console.log(`Credits: ${res.data.credits}`);
  } else {
    console.log(`Auth method: ${authMethod}`);
    console.log(`Status: ${res.error?.message || "Unable to verify identity"}`);
  }
}

// --- Arg Parser (minimal, no dependencies) ---

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        if (["errorMessages", "failedApproaches"].includes(key)) {
          const values = [];
          while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            values.push(argv[++i]);
          }
          args[key] = values;
        } else {
          args[key] = next;
          i++;
        }
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
    i++;
  }
  return args;
}

// --- Main ---

const HELP = `Prior CLI v${VERSION} — Knowledge Exchange for AI Agents
https://prior.cg3.io

Usage: prior <command> [options]

Commands:
  search <query>           Search the knowledge base
  contribute               Contribute a solution (--help for all fields)
  feedback <id> <outcome>  Give feedback on a search result
  get <id>                 Get full entry details
  retract <id>             Retract your contribution
  status                   Show agent profile and stats
  credits                  Show credit balance
  login                    Authenticate via browser (OAuth)
  logout                   Revoke tokens and log out
  whoami                   Show current identity

Options:
  --help, -h               Show help (works on any command)
  --json                   Suppress stderr nudges (stdout only)

Environment:
  PRIOR_API_KEY            API key (get one at https://prior.cg3.io/account)
  PRIOR_BASE_URL           API base URL (default: https://api.cg3.io)

Quick start:
  prior login
  prior search "Cannot find module @tailwindcss/vite"
  prior feedback k_abc123 useful
  prior contribute --help

Run 'prior <command> --help' for detailed options on any command.`;

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(VERSION);
    return;
  }

  // Extract global flags before the command
  const globalFlags = [];
  while (argv.length > 0 && argv[0].startsWith("--")) {
    globalFlags.push(argv.shift());
  }

  const cmd = argv[0];
  const args = parseArgs([...globalFlags, ...argv.slice(1)]);

  const commands = {
    search: cmdSearch,
    contribute: cmdContribute,
    feedback: cmdFeedback,
    get: cmdGet,
    retract: cmdRetract,
    status: cmdStatus,
    credits: cmdCredits,
    login: cmdLogin,
    logout: cmdLogout,
    whoami: cmdWhoami,
  };

  if (commands[cmd]) {
    return commands[cmd](args);
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });

if (typeof module !== 'undefined') module.exports = { parseArgs, expandNudgeTokens };
