// prior setup — One-command installation for AI coding tools.
// Zero dependencies. Part of @cg3/prior-node.
// https://prior.cg3.io

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");
const readline = require("readline");

// ─── Constants ───────────────────────────────────────────────

const MCP_URL = "https://api.cg3.io/mcp";

// ─── Platform Detection ──────────────────────────────────────

function whichSync(cmd) {
  try {
    const r = execSync(process.platform === "win32" ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return r.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function getClaudeCodeVersion() {
  try {
    const out = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 5000 });
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

function getCursorVersion() {
  try {
    const out = execSync("cursor --version 2>&1", { encoding: "utf-8", timeout: 5000 });
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

/**
 * Detect installed AI coding platforms.
 * Returns array of { platform, version, configPath, rulesPath, existingMcp }
 */
function detectPlatforms() {
  const home = os.homedir();
  const platforms = [];

  // Claude Code
  const claudeVersion = whichSync("claude") ? getClaudeCodeVersion() : null;
  if (claudeVersion || dirExists(path.join(home, ".claude"))) {
    const configPath = path.join(home, ".claude.json");
    const rulesPath = path.join(home, ".claude", "CLAUDE.md");
    const existingMcp = readMcpEntry(configPath, "mcpServers");
    platforms.push({
      platform: "claude-code",
      version: claudeVersion || "unknown",
      configPath,
      rulesPath,
      skillDir: path.join(home, ".claude", "skills", "prior", "search"),
      existingMcp,
      hasCli: !!whichSync("claude"),
      rootKey: "mcpServers",
    });
  }

  // Cursor
  const cursorDir = path.join(home, ".cursor");
  if (whichSync("cursor") || dirExists(cursorDir)) {
    const configPath = path.join(cursorDir, "mcp.json");
    const existingMcp = readMcpEntry(configPath, "mcpServers");
    platforms.push({
      platform: "cursor",
      version: getCursorVersion() || "unknown",
      configPath,
      rulesPath: null, // Cursor: clipboard only
      existingMcp,
      hasCli: !!whichSync("cursor"),
      rootKey: "mcpServers",
    });
  }

  // Windsurf
  const windsurfDir = path.join(home, ".codeium", "windsurf");
  if (dirExists(windsurfDir)) {
    const configPath = path.join(windsurfDir, "mcp_config.json");
    const rulesPath = path.join(windsurfDir, "memories", "global_rules.md");
    const existingMcp = readMcpEntry(configPath, "mcpServers");
    platforms.push({
      platform: "windsurf",
      version: "unknown",
      configPath,
      rulesPath,
      existingMcp,
      hasCli: false,
      rootKey: "mcpServers",
    });
  }

  return platforms;
}

function readMcpEntry(configPath, rootKey) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return data?.[rootKey]?.prior || null;
  } catch { return null; }
}

// ─── MCP Config Installation ─────────────────────────────────

function buildHttpConfig() {
  return {
    type: "http",
    url: MCP_URL,
  };
}

function buildHttpConfigWithAuth(apiKey) {
  return {
    ...buildHttpConfig(),
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

function buildStdioConfig(apiKey) {
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "npx", "-y", "@cg3/prior-mcp"],
      env: { PRIOR_API_KEY: apiKey },
    };
  }
  return {
    command: "npx",
    args: ["-y", "@cg3/prior-mcp"],
    env: { PRIOR_API_KEY: apiKey },
  };
}

function buildMcpConfig(apiKey, transport) {
  if (transport === "stdio") return buildStdioConfig(apiKey);
  return buildHttpConfigWithAuth(apiKey);
}

/**
 * Install MCP config for a platform via CLI or JSON write.
 * Returns { success, method } or throws.
 */
function installMcp(platform, apiKey, transport, dryRun) {
  const config = buildMcpConfig(apiKey, transport);

  // Claude Code: try CLI first
  if (platform.platform === "claude-code" && platform.hasCli && transport === "http") {
    try {
      if (!dryRun) {
        const headerArg = `Authorization: Bearer ${apiKey}`;
        execSync(`claude mcp add --transport http -s user --header "${headerArg}" prior ${MCP_URL}`, {
          encoding: "utf-8",
          timeout: 15000,
          stdio: "pipe",
        });
      }
      return { success: true, method: "cli" };
    } catch {
      // Fall through to JSON
    }
  }

  // Cursor: try CLI first
  if (platform.platform === "cursor" && platform.hasCli) {
    try {
      const mcpJson = JSON.stringify({ name: "prior", ...config });
      if (!dryRun) {
        execSync(`cursor --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, {
          encoding: "utf-8",
          timeout: 15000,
          stdio: "pipe",
        });
      }
      return { success: true, method: "cli" };
    } catch {
      // Fall through to JSON
    }
  }

  // JSON write (all platforms, fallback for CLI failures)
  return installMcpJson(platform, config, dryRun);
}

function installMcpJson(platform, mcpEntry, dryRun) {
  const { configPath, rootKey } = platform;

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (typeof existing !== "object" || existing === null) existing = {};
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  if (!existing[rootKey]) existing[rootKey] = {};
  existing[rootKey].prior = mcpEntry;

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Backup existing file
    if (fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }

    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  }

  return { success: true, method: "json" };
}

/**
 * Remove MCP "prior" entry from a platform config.
 */
function uninstallMcp(platform, dryRun) {
  const { configPath, rootKey } = platform;
  if (!fileExists(configPath)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!data?.[rootKey]?.prior) return false;
    delete data[rootKey].prior;
    if (Object.keys(data[rootKey]).length === 0) delete data[rootKey];
    if (!dryRun) {
      fs.copyFileSync(configPath, configPath + ".bak");
      if (Object.keys(data).length === 0) {
        fs.unlinkSync(configPath);
      } else {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Update API key in existing MCP config for a platform.
 */
function updateMcpKey(platform, apiKey, transport) {
  const config = buildMcpConfig(apiKey, transport);
  return installMcpJson(platform, config, false);
}

// ─── Behavioral Rules Installation ───────────────────────────

function getBundledRules() {
  const rulesPath = path.join(__dirname, "..", "skills", "condensed.md");
  return fs.readFileSync(rulesPath, "utf-8").trim();
}

function getBundledSkill() {
  const skillPath = path.join(__dirname, "..", "skills", "search", "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

const PRIOR_MARKER_RE = /<!-- prior:v[\d.]+ -->/;
const PRIOR_BLOCK_RE = /<!-- prior:v[\d.]+ -->[\s\S]*?<!-- \/prior -->\n?/;

function parseRulesVersion(content) {
  const m = content.match(/<!-- prior:v([\d.]+) -->/);
  return m ? m[1] : null;
}

/**
 * Install behavioral rules to a platform's rules file.
 * Returns { action: 'created' | 'updated' | 'skipped' | 'clipboard' }
 */
function installRules(platform, bundledRules, currentVersion, dryRun) {
  // Cursor: clipboard only
  if (platform.platform === "cursor") {
    if (!dryRun) {
      copyToClipboard(bundledRules);
    }
    return { action: "clipboard" };
  }

  if (!platform.rulesPath) return { action: "skipped" };

  let existing = "";
  try { existing = fs.readFileSync(platform.rulesPath, "utf-8"); } catch {}

  const existingVersion = parseRulesVersion(existing);

  if (existingVersion === currentVersion) {
    return { action: "skipped" };
  }

  if (!dryRun) {
    const dir = path.dirname(platform.rulesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (existingVersion) {
      // Replace existing block
      const updated = existing.replace(PRIOR_BLOCK_RE, bundledRules + "\n");
      fs.writeFileSync(platform.rulesPath, updated);
      return { action: "updated" };
    }

    // Append
    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(platform.rulesPath, existing + sep + bundledRules + "\n");
    return { action: "created" };
  }

  return { action: existingVersion ? "updated" : "created" };
}

/**
 * Remove Prior rules from a platform's rules file.
 */
function uninstallRules(platform, dryRun) {
  if (!platform.rulesPath || !fileExists(platform.rulesPath)) return false;
  try {
    const content = fs.readFileSync(platform.rulesPath, "utf-8");
    if (!PRIOR_MARKER_RE.test(content)) return false;
    if (!dryRun) {
      const cleaned = content.replace(PRIOR_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned) {
        fs.writeFileSync(platform.rulesPath, cleaned + "\n");
      } else {
        fs.unlinkSync(platform.rulesPath);
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Install Claude Code skill files (bonus).
 */
function installSkill(platform, dryRun) {
  if (platform.platform !== "claude-code" || !platform.skillDir) return false;
  if (!dryRun) {
    fs.mkdirSync(platform.skillDir, { recursive: true });
    fs.writeFileSync(path.join(platform.skillDir, "SKILL.md"), getBundledSkill());
  }
  return true;
}

function uninstallSkill(platform, dryRun) {
  if (platform.platform !== "claude-code" || !platform.skillDir) return false;
  const skillFile = path.join(platform.skillDir, "SKILL.md");
  if (!fileExists(skillFile)) return false;
  if (!dryRun) {
    try { fs.unlinkSync(skillFile); } catch {}
    // Remove empty directories up to .claude/skills/
    try { fs.rmdirSync(platform.skillDir); } catch {}
    try { fs.rmdirSync(path.dirname(platform.skillDir)); } catch {}
  }
  return true;
}

// ─── Clipboard ───────────────────────────────────────────────

function copyToClipboard(text) {
  try {
    const cp = require("child_process");
    if (process.platform === "darwin") {
      cp.execSync("pbcopy", { input: text, timeout: 3000 });
    } else if (process.platform === "win32") {
      cp.execSync("clip", { input: text, timeout: 3000 });
    } else {
      // Try xclip, xsel, wl-copy
      try { cp.execSync("xclip -selection clipboard", { input: text, timeout: 3000 }); }
      catch { try { cp.execSync("xsel --clipboard --input", { input: text, timeout: 3000 }); }
      catch { cp.execSync("wl-copy", { input: text, timeout: 3000 }); } }
    }
    return true;
  } catch { return false; }
}

// ─── Verification ────────────────────────────────────────────

async function verifySetup(platform, apiKey, apiUrl, currentVersion) {
  const results = { mcp: false, api: false, search: false, rules: false, skill: false };

  // 1. MCP config exists
  results.mcp = !!readMcpEntry(platform.configPath, platform.rootKey);

  // 2. API reachable
  try {
    const res = await fetch(`${apiUrl}/v1/agents/status`, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "prior-setup" },
    });
    results.api = res.ok;
  } catch {}

  // 3. Test search (fire and forget, just check for 200)
  try {
    const res = await fetch(`${apiUrl}/v1/knowledge/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "prior-setup",
      },
      body: JSON.stringify({ query: "prior setup test", maxResults: 1 }),
    });
    results.search = res.ok;
  } catch {}

  // 4. Rules exist
  if (platform.rulesPath) {
    try {
      const content = fs.readFileSync(platform.rulesPath, "utf-8");
      results.rules = PRIOR_MARKER_RE.test(content);
    } catch {}
  } else if (platform.platform === "cursor") {
    results.rules = true; // Can't verify clipboard paste
  }

  // 5. Skill exists (Claude Code only)
  if (platform.platform === "claude-code" && platform.skillDir) {
    results.skill = fileExists(path.join(platform.skillDir, "SKILL.md"));
  }

  return results;
}

// ─── Setup Report ────────────────────────────────────────────

async function sendSetupReport(apiKey, apiUrl, cliVersion, platformResults) {
  try {
    await fetch(`${apiUrl}/v1/agents/setup-report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": `prior-setup/${cliVersion}`,
      },
      body: JSON.stringify({
        cliVersion,
        os: process.platform,
        nodeVersion: process.version,
        platforms: platformResults.map(r => ({
          platform: r.platform,
          version: r.version,
          transport: r.transport,
          success: r.success,
          error: r.error ? sanitizeError(r.error) : undefined,
        })),
      }),
    });
  } catch {
    // Fire and forget
  }
}

function sanitizeError(msg) {
  return msg.replace(os.homedir(), "~");
}

// ─── Interactive Prompts ─────────────────────────────────────

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── Output Helpers ──────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg = "") { process.stderr.write(msg + "\n"); }
function ok(msg) { log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { log(`  ${RED}✗${RESET} ${msg}`); }
function warn(msg) { log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function info(msg) { log(`  ${CYAN}ⓘ${RESET} ${msg}`); }
function step(n, total, title) { log(`\n${BOLD}Step ${n}/${total}: ${title}${RESET}`); }

function platformName(id) {
  const names = { "claude-code": "Claude Code", cursor: "Cursor", windsurf: "Windsurf" };
  return names[id] || id;
}

// ─── Main Setup Command ──────────────────────────────────────

/**
 * @param {object} args - Parsed CLI args
 * @param {object} deps - Injected dependencies { VERSION, API_URL, loadConfig, saveConfig, api, cmdLogin, escapeHtml }
 */
async function cmdSetup(args, deps) {
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;

  if (args.help) {
    log(`prior setup [options]

One-command installation of Prior for AI coding tools.
Detects your environment, authenticates, configures MCP, and installs
behavioral rules so your agents start using Prior automatically.

Options:
  --platform <name>      Target: claude-code, cursor, windsurf
  --transport http|stdio Transport (default: http)
  --api-key <key>        Use this API key (skips OAuth)
  --api-key-file <path>  Read API key from file (- for stdin)
  --skip-auth            Skip auth (use existing credentials)
  --skip-mcp             Skip MCP server installation
  --skip-rules           Skip behavioral rules installation
  --non-interactive      No prompts (fail if info missing)
  --dry-run              Preview without writing
  --update               Refresh rules, auto-recover auth
  --rekey                Rotate API key, update all configs
  --uninstall            Remove Prior from detected platforms
  --help                 Show this help

Examples:
  prior setup                          # Interactive (recommended)
  prior setup --platform claude-code   # Specific platform
  prior setup --transport stdio        # Local MCP server
  prior setup --update                 # Refresh everything
  prior setup --rekey                  # Rotate API key
  prior setup --uninstall              # Remove Prior`);
    return;
  }

  const transport = args.transport || "http";
  const dryRun = !!args.dryRun;
  const nonInteractive = !!args.nonInteractive;

  if (dryRun) log(`${DIM}(dry run — no files will be modified)${RESET}`);

  // ── Uninstall Mode ──
  if (args.uninstall) {
    return runUninstall(args, dryRun, VERSION);
  }

  // ── Detection ──
  log(`\n${BOLD}Prior Setup${RESET}`);
  log("===========\n");
  log("Detecting environment...");

  let platforms = detectPlatforms();
  log(`  OS:        ${process.platform} ${os.arch()}`);
  log(`  Node:      ${process.version}`);

  // Filter by --platform if specified
  if (args.platform) {
    platforms = platforms.filter(p => p.platform === args.platform);
    if (platforms.length === 0) {
      // Even if not detected, allow manual override
      platforms = [createManualPlatform(args.platform)];
    }
  }

  if (platforms.length === 0) {
    fail("No supported AI coding tools detected.");
    log(`\n  Install one of: Claude Code, Cursor, Windsurf`);
    log(`  Or specify manually: prior setup --platform claude-code`);
    process.exit(1);
  }

  const names = platforms.map(p => `${platformName(p.platform)} ${p.version !== "unknown" ? `v${p.version}` : ""}`).join(", ");
  log(`  Platform${platforms.length > 1 ? "s" : ""}: ${names.trim()}`);

  // ── Rekey Mode ──
  if (args.rekey) {
    return runRekey(args, deps, platforms, transport, nonInteractive, dryRun);
  }

  // ── Check existing setup (for --update or idempotent re-run) ──
  if (args.update) {
    return runUpdate(args, deps, platforms, transport, nonInteractive, dryRun);
  }

  // ── Step 1: Authentication ──
  const totalSteps = 4;
  step(1, totalSteps, "Authentication");

  let apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
  if (!apiKey) {
    fail("Authentication failed. Cannot continue.");
    log(`\n  → Try: prior setup --api-key <key>`);
    log(`  → Get a key: https://prior.cg3.io/account`);
    process.exit(1);
  }

  // Validate the key
  const whoami = await api("GET", "/v1/agents/me", null, apiKey);
  if (whoami.ok && whoami.data) {
    ok(`Authenticated as ${whoami.data.agentId} (${whoami.data.credits} credits)`);
  } else {
    fail("API key validation failed");
    log(`  → Key might be invalid. Try: prior setup --api-key <new-key>`);
    process.exit(1);
  }

  // ── Step 2: MCP Server ──
  step(2, totalSteps, "MCP Server");
  log(`  Transport: ${transport === "http" ? "HTTP (remote — no local install needed)" : "stdio (local)"}`);

  const platformResults = [];
  for (const p of platforms) {
    if (args.skipMcp) {
      info(`${platformName(p.platform)}: Skipped (--skip-mcp)`);
      platformResults.push({ ...p, transport, mcpSuccess: true, mcpMethod: "skipped" });
      continue;
    }

    try {
      const result = installMcp(p, apiKey, transport, dryRun);
      ok(`${platformName(p.platform)}: MCP server "prior" ${dryRun ? "would be " : ""}added (${transport}, ${result.method})`);
      platformResults.push({ ...p, transport, mcpSuccess: true, mcpMethod: result.method });
    } catch (e) {
      fail(`${platformName(p.platform)}: ${e.message}`);
      platformResults.push({ ...p, transport, mcpSuccess: false, error: e.message });
    }
  }

  // ── Step 3: Behavioral Rules ──
  step(3, totalSteps, "Behavioral Rules");

  const bundledRules = getBundledRules();

  for (const p of platformResults) {
    if (args.skipRules) {
      info(`${platformName(p.platform)}: Skipped (--skip-rules)`);
      continue;
    }

    if (!p.mcpSuccess && p.platform !== "cursor") {
      log(`  ${DIM}— ${platformName(p.platform)}: Skipped (MCP install failed)${RESET}`);
      continue;
    }

    try {
      const rResult = installRules(p, bundledRules, VERSION, dryRun);
      if (rResult.action === "clipboard") {
        const copied = !dryRun;
        if (copied) {
          info(`${platformName(p.platform)}: Rules copied to clipboard`);
          log(`    → Paste in: Cursor > Settings (Cmd+,) > Rules`);
        } else {
          info(`${platformName(p.platform)}: Rules would be copied to clipboard`);
        }
      } else if (rResult.action === "skipped") {
        ok(`${platformName(p.platform)}: Rules already up to date`);
      } else {
        ok(`${platformName(p.platform)}: Prior rules ${rResult.action} in ${p.rulesPath?.replace(os.homedir(), "~") || "rules file"}`);
      }

      // Claude Code bonus: install skill
      if (p.platform === "claude-code") {
        installSkill(p, dryRun);
        ok(`${platformName(p.platform)}: Skill installed to ~/.claude/skills/prior/`);
      }
    } catch (e) {
      fail(`${platformName(p.platform)}: ${e.message}`);
    }
  }

  // ── Step 4: Verification ──
  step(4, totalSteps, "Verification");

  let allGood = true;
  for (const p of platformResults) {
    if (!p.mcpSuccess) {
      fail(`${platformName(p.platform)}: MCP failed`);
      allGood = false;
      continue;
    }

    if (dryRun) {
      ok(`${platformName(p.platform)}: (dry run — skipping verification)`);
      continue;
    }

    const v = await verifySetup(p, apiKey, API_URL, VERSION);
    const checks = [];
    if (v.mcp) checks.push("MCP ✓"); else { checks.push("MCP ✗"); allGood = false; }
    if (v.api) checks.push("API ✓"); else { checks.push("API ✗"); allGood = false; }
    if (v.search) checks.push("Search ✓"); else checks.push("Search ✗");
    if (v.rules) checks.push("Rules ✓");
    if (p.platform === "claude-code" && v.skill) checks.push("Skill ✓");

    if (v.mcp && v.api) {
      ok(`${platformName(p.platform)}: ${checks.join("  ")}`);
    } else {
      fail(`${platformName(p.platform)}: ${checks.join("  ")}`);
    }
  }

  // Send setup report (fire and forget)
  if (!dryRun) {
    sendSetupReport(apiKey, API_URL, VERSION, platformResults.map(p => ({
      platform: p.platform,
      version: p.version,
      transport: p.transport,
      success: p.mcpSuccess,
      error: p.error,
    })));
  }

  // ── Summary ──
  log("");
  const succeeded = platformResults.filter(p => p.mcpSuccess);
  const failed = platformResults.filter(p => !p.mcpSuccess);

  if (failed.length === 0) {
    const platList = succeeded.map(p => platformName(p.platform)).join(", ");
    log(`${BOLD}Prior ${dryRun ? "would be " : ""}installed for ${platList} (${transport}).${RESET}`);
    log(`\nYour agents will now search the knowledge base before solving`);
    log(`problems and may occasionally ask to contribute solutions`);
    log(`you've discovered.`);
  } else if (succeeded.length > 0) {
    log(`${BOLD}Prior partially installed.${RESET}`);
    for (const s of succeeded) ok(`${platformName(s.platform)} is ready`);
    for (const f of failed) {
      fail(`${platformName(f.platform)} setup failed:`);
      log(`    → ${f.error}`);
      log(`    → Fix: prior setup --platform ${f.platform}`);
    }
  } else {
    log(`${RED}${BOLD}Prior setup failed.${RESET}`);
    for (const f of failed) {
      fail(`${f.error}`);
    }
  }

  log(`\n  Dashboard:  https://prior.cg3.io`);
  log(`  Help:       prior@cg3.io`);
  if (succeeded.length > 0) {
    log(`  Commands:   prior setup --update | --rekey | --uninstall`);
  }

  // Cursor warning
  if (succeeded.some(p => p.platform === "cursor")) {
    log(`\n  ${YELLOW}⚠ Cursor note:${RESET} If Prior tools aren't available after restarting Cursor,`);
    log(`    go to Settings > MCP and ensure the "prior" server is enabled.`);
  }
}

// ─── Auth Resolution ─────────────────────────────────────────

async function resolveAuth(args, deps, nonInteractive, dryRun) {
  const { loadConfig, saveConfig, api, VERSION, API_URL, readApiKeyFromFile, doOAuthLogin } = deps;

  // 1. --api-key flag
  if (args.apiKey) {
    const key = args.apiKey;
    const config = loadConfig() || {};
    config.apiKey = key;
    if (!dryRun) saveConfig(config);
    return key;
  }

  // 2. --api-key-file flag
  if (args.apiKeyFile) {
    const key = readApiKeyFromFile(args.apiKeyFile);
    const config = loadConfig() || {};
    config.apiKey = key;
    if (!dryRun) saveConfig(config);
    return key;
  }

  // 3. Check existing credentials
  const config = loadConfig();

  // 3a. Existing API key — validate it
  const existingKey = process.env.PRIOR_API_KEY || config?.apiKey;
  if (existingKey) {
    const check = await api("GET", "/v1/agents/me", null, existingKey);
    if (check.ok) {
      ok("Existing API key valid");
      return existingKey;
    }
    warn("Existing API key invalid (401)");
    // Fall through to re-auth
  }

  // 3b. Existing OAuth tokens — try to get API key via cli-key endpoint
  if (config?.tokens?.access_token) {
    const refreshed = await deps.refreshTokenIfNeeded?.();
    const jwt = refreshed || config.tokens.access_token;

    // Try to get/generate API key
    const cliKeyRes = await api("POST", "/v1/agents/cli-key", { regenerate: false }, jwt);
    if (cliKeyRes.ok && cliKeyRes.data?.apiKey) {
      const key = cliKeyRes.data.apiKey;
      const cfg = loadConfig() || {};
      cfg.apiKey = key;
      if (!dryRun) saveConfig(cfg);
      ok(`API key obtained for MCP configuration`);
      return key;
    }

    // 409: key already exists but we don't have it locally
    if (cliKeyRes.error?.code === "KEY_EXISTS") {
      if (nonInteractive) {
        fail("API key exists on server but not locally. Use --api-key to provide it.");
        return null;
      }

      log(`\n  You already have an API key from a previous setup.`);
      log(`    [1] Generate a new key (recommended)`);
      log(`        → Your old key will stop working.`);
      log(`    [2] Enter your existing key`);
      log(`        → Find at: https://prior.cg3.io/account`);
      const choice = await prompt("  Choice [1]: ");

      if (choice === "2") {
        const manual = await prompt("  Paste your API key: ");
        if (manual) {
          const cfg = loadConfig() || {};
          cfg.apiKey = manual;
          if (!dryRun) saveConfig(cfg);
          return manual;
        }
        return null;
      }

      // Default: regenerate
      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, jwt);
      if (regenRes.ok && regenRes.data?.apiKey) {
        const key = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = key;
        if (!dryRun) saveConfig(cfg);
        ok("New API key generated");
        return key;
      }
      fail("Failed to regenerate key: " + (regenRes.error?.message || "unknown error"));
      return null;
    }
  }

  // 4. --skip-auth: use whatever we have
  if (args.skipAuth) {
    fail("No valid credentials found. Cannot skip auth.");
    return null;
  }

  // 5. Non-interactive with no creds
  if (nonInteractive) {
    fail("No credentials found. Use --api-key or --api-key-file.");
    return null;
  }

  // 6. Interactive: offer OAuth or API key paste
  log(`\n  No Prior credentials found.`);
  log(`    [1] Log in with browser (GitHub/Google) — recommended`);
  log(`    [2] Enter API key manually`);
  const choice = await prompt("  Choice [1]: ");

  if (choice === "2") {
    const manual = await prompt("  Paste your API key: ");
    if (manual) {
      const cfg = loadConfig() || {};
      cfg.apiKey = manual;
      if (!dryRun) saveConfig(cfg);
      return manual;
    }
    return null;
  }

  // OAuth flow — reuse existing login, then get API key
  log("  Opening browser for authentication...");
  await doOAuthLogin();

  // After OAuth, try to get API key
  const postOauthConfig = loadConfig();
  if (postOauthConfig?.tokens?.access_token) {
    const jwt = postOauthConfig.tokens.access_token;
    const cliKeyRes = await api("POST", "/v1/agents/cli-key", { regenerate: false }, jwt);

    if (cliKeyRes.ok && cliKeyRes.data?.apiKey) {
      const key = cliKeyRes.data.apiKey;
      const cfg = loadConfig() || {};
      cfg.apiKey = key;
      if (!dryRun) saveConfig(cfg);
      ok("Authenticated & API key obtained");
      return key;
    }

    // 409 — same handling as above
    if (cliKeyRes.error?.code === "KEY_EXISTS") {
      log(`\n  You already have an API key. Generating a new one...`);
      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, jwt);
      if (regenRes.ok && regenRes.data?.apiKey) {
        const key = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = key;
        if (!dryRun) saveConfig(cfg);
        ok("New API key generated");
        return key;
      }
    }
  }

  fail("OAuth login did not produce credentials.");
  return null;
}

// ─── Update Mode ─────────────────────────────────────────────

async function runUpdate(args, deps, platforms, transport, nonInteractive, dryRun) {
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;

  log(`\n${BOLD}Prior Update${RESET}`);
  log("============\n");

  // Validate auth
  log("Checking credentials...");
  let apiKey = process.env.PRIOR_API_KEY || loadConfig()?.apiKey;

  if (apiKey) {
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (check.ok) {
      ok(`API key valid (${check.data.agentId})`);
    } else {
      warn("API key invalid (401)");
      apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
      if (!apiKey) {
        fail("Could not restore authentication.");
        process.exit(1);
      }
      // Update all platform MCP configs with new key
      log("\nUpdating MCP configs with new key...");
      for (const p of platforms) {
        try {
          updateMcpKey(p, apiKey, transport);
          ok(`${platformName(p.platform)} (${p.configPath.replace(os.homedir(), "~")})`);
        } catch (e) {
          fail(`${platformName(p.platform)}: ${e.message}`);
        }
      }
    }
  } else {
    apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
    if (!apiKey) {
      fail("No credentials. Run: prior setup");
      process.exit(1);
    }
  }

  // Update rules
  log("\nUpdating behavioral rules...");
  const bundledRules = getBundledRules();
  for (const p of platforms) {
    const result = installRules(p, bundledRules, VERSION, dryRun);
    if (result.action === "skipped") {
      ok(`${platformName(p.platform)}: No changes needed`);
    } else if (result.action === "updated") {
      ok(`${platformName(p.platform)}: Rules updated to v${VERSION}`);
    } else if (result.action === "created") {
      ok(`${platformName(p.platform)}: Rules added`);
    } else if (result.action === "clipboard") {
      info(`${platformName(p.platform)}: Updated rules copied to clipboard`);
      log(`    → Paste in: Cursor > Settings > Rules`);
    }

    // Update skill for Claude Code
    if (p.platform === "claude-code") {
      installSkill(p, dryRun);
    }
  }

  // Check MCP configs are still correct
  log("\nUpdating MCP config...");
  for (const p of platforms) {
    if (readMcpEntry(p.configPath, p.rootKey)) {
      ok(`${platformName(p.platform)}: No changes needed`);
    } else {
      try {
        installMcp(p, apiKey, transport, dryRun);
        ok(`${platformName(p.platform)}: MCP config restored`);
      } catch (e) {
        fail(`${platformName(p.platform)}: ${e.message}`);
      }
    }
  }

  const platList = platforms.map(p => platformName(p.platform)).join(", ");
  log(`\n${BOLD}Prior updated for ${platList}.${RESET}`);
  log(`\n  Dashboard:  https://prior.cg3.io`);
  log(`  Help:       prior@cg3.io`);
}

// ─── Rekey Mode ──────────────────────────────────────────────

async function runRekey(args, deps, platforms, transport, nonInteractive, dryRun) {
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;

  log(`\n${BOLD}Prior Rekey${RESET}`);
  log("===========\n");

  const configured = platforms.filter(p => readMcpEntry(p.configPath, p.rootKey));
  log("Detecting configured platforms...");
  for (const p of configured) ok(`${platformName(p.platform)} (${transport}, ${p.configPath.replace(os.homedir(), "~")})`);
  for (const p of platforms.filter(pp => !configured.includes(pp))) {
    log(`  ${DIM}— ${platformName(p.platform)}: not configured (skip)${RESET}`);
  }

  if (configured.length === 0) {
    fail("No platforms configured. Run: prior setup");
    process.exit(1);
  }

  // Get new key
  let apiKey;
  if (args.apiKey) {
    log("\nValidating provided key...");
    apiKey = args.apiKey;
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (!check.ok) {
      fail("Provided key is invalid.");
      process.exit(1);
    }
    ok(`Key valid (${check.data.agentId})`);
  } else if (args.apiKeyFile) {
    apiKey = deps.readApiKeyFromFile(args.apiKeyFile);
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (!check.ok) {
      fail("Key from file is invalid.");
      process.exit(1);
    }
    ok(`Key valid (${check.data.agentId})`);
  } else {
    // OAuth → regenerate
    log("\nGenerating new API key...");
    apiKey = await resolveAuth({ ...args, skipAuth: false }, deps, nonInteractive, dryRun);
    if (!apiKey) {
      fail("Could not obtain new key.");
      process.exit(1);
    }

    // For rekey, we always regenerate
    const config = loadConfig();
    if (config?.tokens?.access_token) {
      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, config.tokens.access_token);
      if (regenRes.ok && regenRes.data?.apiKey) {
        apiKey = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = apiKey;
        if (!dryRun) saveConfig(cfg);
        ok("New API key generated");
      }
    }
  }

  // Confirm
  if (!nonInteractive && !args.apiKey && !args.apiKeyFile) {
    warn("This replaces your previous API key.");
    log("    Any other integrations using the old key will stop working.");
    const confirm = await prompt("  Proceed? [Y/n] ");
    if (confirm.toLowerCase() === "n") {
      log("Cancelled.");
      return;
    }
  }

  // Update all configs
  log("\nUpdating MCP configs...");
  for (const p of configured) {
    try {
      updateMcpKey(p, apiKey, transport);
      ok(`${platformName(p.platform)} (${p.configPath.replace(os.homedir(), "~")})`);
    } catch (e) {
      fail(`${platformName(p.platform)}: ${e.message}`);
    }
  }

  // Save to config.json
  if (!dryRun) {
    const cfg = loadConfig() || {};
    cfg.apiKey = apiKey;
    saveConfig(cfg);
    ok(`~/.prior/config.json`);
  }

  const platList = configured.map(p => platformName(p.platform)).join(", ");
  log(`\n${BOLD}API key rotated for ${platList}.${RESET}`);
  log(`\n  Dashboard:  https://prior.cg3.io`);
  log(`  Help:       prior@cg3.io`);
}

// ─── Uninstall Mode ──────────────────────────────────────────

async function runUninstall(args, dryRun, VERSION) {
  log(`\n${BOLD}Prior Uninstall${RESET}`);
  log("===============\n");

  let platforms = detectPlatforms();
  if (args.platform) {
    platforms = platforms.filter(p => p.platform === args.platform);
  }

  if (platforms.length === 0) {
    log("  No Prior installations found.");
    return;
  }

  for (const p of platforms) {
    const mcpRemoved = uninstallMcp(p, dryRun);
    const rulesRemoved = uninstallRules(p, dryRun);
    const skillRemoved = uninstallSkill(p, dryRun);

    if (mcpRemoved || rulesRemoved || skillRemoved) {
      ok(`${platformName(p.platform)}: ${dryRun ? "would be " : ""}removed`);
      if (mcpRemoved) log(`    MCP config removed`);
      if (rulesRemoved) log(`    Behavioral rules removed`);
      if (skillRemoved) log(`    Skill files removed`);
    } else {
      log(`  ${DIM}— ${platformName(p.platform)}: nothing to remove${RESET}`);
    }
  }

  log(`\n  Note: ~/.prior/config.json was NOT removed (contains your auth).`);
  log(`  To remove: rm ~/.prior/config.json`);
}

// ─── Manual Platform Override ────────────────────────────────

function createManualPlatform(platformId) {
  const home = os.homedir();
  const configs = {
    "claude-code": {
      configPath: path.join(home, ".claude.json"),
      rulesPath: path.join(home, ".claude", "CLAUDE.md"),
      skillDir: path.join(home, ".claude", "skills", "prior", "search"),
      rootKey: "mcpServers",
    },
    cursor: {
      configPath: path.join(home, ".cursor", "mcp.json"),
      rulesPath: null,
      rootKey: "mcpServers",
    },
    windsurf: {
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      rulesPath: path.join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
      rootKey: "mcpServers",
    },
  };

  const def = configs[platformId];
  if (!def) {
    throw new Error(`Unknown platform: ${platformId}. Supported: claude-code, cursor, windsurf`);
  }

  return { platform: platformId, version: "unknown", hasCli: false, existingMcp: null, ...def };
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
  cmdSetup,
  detectPlatforms,
  buildMcpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installMcp,
  installMcpJson,
  uninstallMcp,
  updateMcpKey,
  installRules,
  uninstallRules,
  installSkill,
  uninstallSkill,
  verifySetup,
  parseRulesVersion,
  getBundledRules,
  createManualPlatform,
  copyToClipboard,
  sanitizeError,
  PRIOR_MARKER_RE,
  PRIOR_BLOCK_RE,
};
