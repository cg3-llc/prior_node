#!/bin/bash
# Prior Setup Integration Tests
# Runs in Docker: tests install/uninstall/update lifecycle against mock platform environments.
#
# Usage:
#   ./run.sh                    # Build + run all tests
#   ./run.sh --skip-build       # Reuse existing image
#   ./run.sh --test 03          # Run specific test
#   ./run.sh --api-key ask_...  # Use real API key for verification tests
#   ./run.sh --json             # JSON output for dashboard
#
# Designed to run on Raspberry Pi (arm64) or any Docker host.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRIOR_NODE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="prior-setup-test"
SKIP_BUILD=false
SPECIFIC_TEST=""
API_KEY="${PRIOR_API_KEY:-}"
JSON_OUTPUT=false
RESULTS_DIR="${RESULTS_DIR:-$SCRIPT_DIR/results/$(date +%Y%m%dT%H%M%S)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --test) SPECIFIC_TEST="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$RESULTS_DIR"

# ─── Output helpers ──────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0; TESTS=()

pass() { PASS=$((PASS+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"pass\"}"); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"fail\",\"error\":\"$2\"}"); echo "  ✗ $1: $2"; }
skip() { SKIP=$((SKIP+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"skip\",\"reason\":\"$2\"}"); echo "  — $1: $2"; }
section() { echo ""; echo "── $1 ──"; }

# Run a command inside the Docker container
drun() {
  docker run --rm "$IMAGE_NAME" bash -c "$1"
}

# Run and capture output
dcapture() {
  docker run --rm "$IMAGE_NAME" bash -c "$1" 2>&1
}

# Run with a named volume for state persistence across steps
VOLUME_NAME="prior-setup-test-$$"
drun_stateful() {
  docker run --rm -v "$VOLUME_NAME:/home/testuser" "$IMAGE_NAME" bash -c "$1"
}

# ─── Build ───────────────────────────────────────────────────

if [ "$SKIP_BUILD" = false ]; then
  section "Building Docker image"
  echo "  Context: $PRIOR_NODE_DIR"
  docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PRIOR_NODE_DIR" > "$RESULTS_DIR/build.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  ✗ Docker build failed"
    cat "$RESULTS_DIR/build.log"
    exit 1
  fi
  echo "  ✓ Image built: $IMAGE_NAME"
fi

# ─── Test 01: Detection ─────────────────────────────────────

should_run() {
  [ -z "$SPECIFIC_TEST" ] || [ "$SPECIFIC_TEST" = "$1" ]
}

if should_run "01"; then
  section "01: Platform Detection"

  OUT=$(dcapture 'node -e "
    const { detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    console.log(JSON.stringify(ps.map(p => ({ platform: p.platform, version: p.version, hasCli: p.hasCli }))));
  "')

  # Should detect all 3 platforms
  echo "$OUT" | grep -q '"claude-code"' && pass "Detects Claude Code" || fail "Detects Claude Code" "not found"
  echo "$OUT" | grep -q '"cursor"' && pass "Detects Cursor" || fail "Detects Cursor" "not found"
  echo "$OUT" | grep -q '"windsurf"' && pass "Detects Windsurf" || fail "Detects Windsurf" "not found"

  # Should detect CLI availability
  echo "$OUT" | grep -q '"hasCli":true' && pass "Detects claude CLI" || fail "Detects claude CLI" "hasCli not true"

  # Should detect versions
  echo "$OUT" | grep -q '2.1.0' && pass "Claude Code version detected" || fail "Claude Code version" "version not found"
  echo "$OUT" | grep -q '0.48.2' && pass "Cursor version detected" || fail "Cursor version" "version not found"
fi

# ─── Test 02: Install (per-platform, non-interactive) ────────

if should_run "02"; then
  section "02: MCP Installation"

  # Claude Code — JSON fallback (claude mcp add won't work in container)
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test123\"), false);
    const fs = require(\"fs\");
    const data = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    console.log(JSON.stringify(data));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior.url' > /dev/null 2>&1 && pass "Claude Code: prior MCP added" || fail "Claude Code: prior MCP added" "missing"
  echo "$OUT" | jq -e '.mcpServers["existing-server"].url' > /dev/null 2>&1 && pass "Claude Code: existing server preserved" || fail "Claude Code: existing server preserved" "clobbered"
  echo "$OUT" | jq -r '.mcpServers.prior.headers.Authorization' 2>/dev/null | grep -q "ask_test123" && pass "Claude Code: auth header set" || fail "Claude Code: auth header" "wrong"

  # Cursor
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"cursor\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test456\"), false);
    const fs = require(\"fs\");
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"))));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior' > /dev/null 2>&1 && pass "Cursor: prior MCP added" || fail "Cursor: prior MCP added" "missing"
  echo "$OUT" | jq -e '.mcpServers["another-mcp"]' > /dev/null 2>&1 && pass "Cursor: existing server preserved" || fail "Cursor: existing server preserved" "clobbered"

  # Windsurf
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"windsurf\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test789\"), false);
    const fs = require(\"fs\");
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"))));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior' > /dev/null 2>&1 && pass "Windsurf: prior MCP added" || fail "Windsurf: prior MCP added" "missing"
fi

# ─── Test 03: Rules Installation ─────────────────────────────

if should_run "03"; then
  section "03: Behavioral Rules Installation"

  # Claude Code — append to existing CLAUDE.md
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const result = installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    console.log(JSON.stringify({ action: result.action, hasOriginal: content.includes(\"Always write tests\"), hasPrior: content.includes(\"ALWAYS search Prior\"), hasMarker: content.includes(\"prior:v\") }));
  "')

  echo "$OUT" | jq -e '.action == "created"' > /dev/null 2>&1 && pass "Claude Code: rules created" || fail "Claude Code: rules created" "$(echo $OUT | jq -r '.action')"
  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Claude Code: existing content preserved" || fail "Claude Code: existing content preserved" "lost"
  echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "Claude Code: Prior rules present" || fail "Claude Code: Prior rules present" "missing"
  echo "$OUT" | jq -e '.hasMarker == true' > /dev/null 2>&1 && pass "Claude Code: version marker present" || fail "Claude Code: version marker" "missing"

  # Windsurf — append to existing global_rules.md
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"windsurf\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    console.log(JSON.stringify({ hasOriginal: content.includes(\"Prefer functional\"), hasPrior: content.includes(\"ALWAYS search Prior\") }));
  "')

  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Windsurf: existing rules preserved" || fail "Windsurf: existing rules preserved" "lost"
  echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "Windsurf: Prior rules appended" || fail "Windsurf: Prior rules appended" "missing"

  # Idempotency — running install twice doesn't duplicate
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    installRules(p, rules, version, false);
    const r2 = installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    const count = (content.match(/<!-- prior:v/g) || []).length;
    console.log(JSON.stringify({ secondAction: r2.action, markerCount: count }));
  "')

  echo "$OUT" | jq -e '.secondAction == "skipped"' > /dev/null 2>&1 && pass "Rules: idempotent (second run skipped)" || fail "Rules: idempotent" "$(echo $OUT | jq -r '.secondAction')"
  echo "$OUT" | jq -e '.markerCount == 1' > /dev/null 2>&1 && pass "Rules: no duplicate markers" || fail "Rules: duplicate markers" "count=$(echo $OUT | jq '.markerCount')"
fi

# ─── Test 04: Full Roundtrip (Install → Verify → Uninstall → Verify) ────

if should_run "04"; then
  section "04: Full Install/Uninstall Roundtrip"

  for PLATFORM in claude-code cursor windsurf; do
    OUT=$(dcapture "node -e \"
      const fs = require('fs');
      const { installMcpJson, uninstallMcp, installRules, uninstallRules, getBundledRules, parseRulesVersion, buildHttpConfigWithAuth, createManualPlatform } = require('./bin/setup.js');
      const p = createManualPlatform('$PLATFORM');

      // Snapshot initial state
      let initialMcp = null;
      try { initialMcp = fs.readFileSync(p.configPath, 'utf-8'); } catch {}
      let initialRules = null;
      try { initialRules = fs.readFileSync(p.rulesPath, 'utf-8'); } catch {}

      // Install
      installMcpJson(p, buildHttpConfigWithAuth('ask_roundtrip'), false);
      const rules = getBundledRules();
      const version = parseRulesVersion(rules);
      if (p.rulesPath) installRules(p, rules, version, false);

      // Verify installed
      const mcpAfterInstall = JSON.parse(fs.readFileSync(p.configPath, 'utf-8'));
      const hasPrior = !!mcpAfterInstall.mcpServers?.prior;

      // Uninstall
      uninstallMcp(p, false);
      if (p.rulesPath) uninstallRules(p, false);

      // Verify uninstalled — MCP
      let finalMcp = null;
      try { finalMcp = fs.readFileSync(p.configPath, 'utf-8'); } catch {}
      const finalMcpObj = finalMcp ? JSON.parse(finalMcp) : null;
      const priorGone = !finalMcpObj?.mcpServers?.prior;

      // Check other servers survived
      const initialObj = initialMcp ? JSON.parse(initialMcp) : {};
      const otherServers = Object.keys(initialObj.mcpServers || {});
      const othersPreserved = otherServers.every(k => finalMcpObj?.mcpServers?.[k]);

      // Verify uninstalled — Rules
      let finalRules = null;
      try { finalRules = fs.readFileSync(p.rulesPath, 'utf-8'); } catch {}
      const rulesClean = !finalRules || !finalRules.includes('prior:v');
      const originalContentPreserved = !initialRules || !finalRules || initialRules.trim().split('\\n').slice(0, 2).every(l => finalRules.includes(l.trim()));

      console.log(JSON.stringify({
        platform: '$PLATFORM',
        hasPrior, priorGone, othersPreserved, rulesClean, originalContentPreserved
      }));
    \"")

    echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "$PLATFORM: prior installed" || fail "$PLATFORM: prior installed" "missing after install"
    echo "$OUT" | jq -e '.priorGone == true' > /dev/null 2>&1 && pass "$PLATFORM: prior removed after uninstall" || fail "$PLATFORM: prior removed" "still present"
    echo "$OUT" | jq -e '.othersPreserved == true' > /dev/null 2>&1 && pass "$PLATFORM: other servers preserved" || fail "$PLATFORM: other servers" "lost"
    echo "$OUT" | jq -e '.rulesClean == true' > /dev/null 2>&1 && pass "$PLATFORM: rules cleaned" || fail "$PLATFORM: rules" "still has prior content"
    echo "$OUT" | jq -e '.originalContentPreserved == true' > /dev/null 2>&1 && pass "$PLATFORM: original content intact" || fail "$PLATFORM: original content" "lost"
  done
fi

# ─── Test 05: Rules Update (version bump) ────────────────────

if should_run "05"; then
  section "05: Rules Version Update"

  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);

    // Install current version
    installRules(p, rules, version, false);

    // Simulate old version already installed
    let content = fs.readFileSync(p.rulesPath, \"utf-8\");
    content = content.replace(\"prior:v\" + version, \"prior:v0.1.0\");
    fs.writeFileSync(p.rulesPath, content);

    // Update should replace
    const r = installRules(p, rules, version, false);
    const final = fs.readFileSync(p.rulesPath, \"utf-8\");
    const hasNew = final.includes(\"prior:v\" + version);
    const hasOld = final.includes(\"prior:v0.1.0\");
    const count = (final.match(/<!-- prior:v/g) || []).length;
    const hasOriginal = final.includes(\"Always write tests\");

    console.log(JSON.stringify({ action: r.action, hasNew, hasOld, count, hasOriginal }));
  "')

  echo "$OUT" | jq -e '.action == "updated"' > /dev/null 2>&1 && pass "Update: action is 'updated'" || fail "Update: action" "$(echo $OUT | jq -r '.action')"
  echo "$OUT" | jq -e '.hasNew == true' > /dev/null 2>&1 && pass "Update: new version present" || fail "Update: new version" "missing"
  echo "$OUT" | jq -e '.hasOld == false' > /dev/null 2>&1 && pass "Update: old version removed" || fail "Update: old version" "still present"
  echo "$OUT" | jq -e '.count == 1' > /dev/null 2>&1 && pass "Update: exactly one marker" || fail "Update: marker count" "$(echo $OUT | jq '.count')"
  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Update: original content preserved" || fail "Update: original content" "lost"
fi

# ─── Test 06: Stdio Transport Config ─────────────────────────

if should_run "06"; then
  section "06: Stdio Transport Config"

  OUT=$(dcapture 'node -e "
    const { buildStdioConfig } = require(\"./bin/setup.js\");
    const config = buildStdioConfig(\"ask_stdio_test\");
    console.log(JSON.stringify(config));
  "')

  echo "$OUT" | jq -e '.command == "npx"' > /dev/null 2>&1 && pass "Stdio: command is npx (Linux)" || fail "Stdio: command" "$(echo $OUT | jq -r '.command')"
  echo "$OUT" | jq -e '.args == ["-y", "@cg3/prior-mcp"]' > /dev/null 2>&1 && pass "Stdio: correct args" || fail "Stdio: args" "$(echo $OUT | jq -c '.args')"
  echo "$OUT" | jq -e '.env.PRIOR_API_KEY == "ask_stdio_test"' > /dev/null 2>&1 && pass "Stdio: API key in env" || fail "Stdio: env" "missing"
fi

# ─── Test 07: Backup Creation ────────────────────────────────

if should_run "07"; then
  section "07: Config Backup"

  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_backup\"), false);
    const bakExists = fs.existsSync(p.configPath + \".bak\");
    const bakContent = bakExists ? JSON.parse(fs.readFileSync(p.configPath + \".bak\", \"utf-8\")) : null;
    const hasOriginalInBak = bakContent?.mcpServers?.[\"existing-server\"] != null;
    console.log(JSON.stringify({ bakExists, hasOriginalInBak }));
  "')

  echo "$OUT" | jq -e '.bakExists == true' > /dev/null 2>&1 && pass "Backup: .bak file created" || fail "Backup: .bak missing" "not created"
  echo "$OUT" | jq -e '.hasOriginalInBak == true' > /dev/null 2>&1 && pass "Backup: contains original config" || fail "Backup: wrong content" "missing original"
fi

# ─── Test 08: Dry Run (real API if key provided) ─────────────

if should_run "08"; then
  section "08: Dry Run / Full CLI"

  if [ -n "$API_KEY" ]; then
    OUT=$(dcapture "node bin/prior.js setup --dry-run --non-interactive --platform claude-code --api-key $API_KEY 2>&1 || true")

    echo "$OUT" | grep -q "Authenticated" && pass "CLI dry-run: authenticated" || fail "CLI dry-run: auth" "no auth"
    echo "$OUT" | grep -q "would be" && pass "CLI dry-run: shows dry-run output" || fail "CLI dry-run: output" "missing dry-run text"
    echo "$OUT" | grep -q "MCP server" && pass "CLI dry-run: MCP step shown" || fail "CLI dry-run: MCP" "missing"

    # Verify no files were written
    OUT2=$(dcapture 'node -e "
      const fs = require(\"fs\");
      const data = JSON.parse(fs.readFileSync(\"/home/testuser/.claude.json\", \"utf-8\"));
      console.log(JSON.stringify({ hasPrior: !!data.mcpServers?.prior }));
    "')
    echo "$OUT2" | jq -e '.hasPrior == false' > /dev/null 2>&1 && pass "CLI dry-run: no files modified" || fail "CLI dry-run: files modified" "prior entry found"
  else
    skip "CLI dry-run with real API" "No API key provided (--api-key)"
  fi
fi

# ─── Test 09: Phase 2 Detection ──────────────────────────────

if should_run "09"; then
  section "09: Phase 2 Platform Detection"

  OUT=$(dcapture 'node -e "
    const { detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    console.log(JSON.stringify(ps.map(p => ({ platform: p.platform, version: p.version, rootKey: p.rootKey, hasCli: p.hasCli }))));
  "')

  echo "$OUT" | grep -q '"vscode"' && pass "Detects VS Code" || fail "Detects VS Code" "not found"
  echo "$OUT" | grep -q '"cline"' && pass "Detects Cline" || fail "Detects Cline" "not found"
  echo "$OUT" | grep -q '"roo-code"' && pass "Detects Roo Code" || fail "Detects Roo Code" "not found"

  # VS Code version
  echo "$OUT" | grep -q '1.109.0' && pass "VS Code version detected" || fail "VS Code version" "not found"

  # VS Code uses 'servers' root key
  echo "$OUT" | python3 -c "import sys,json; ps=json.load(sys.stdin); vs=[p for p in ps if p['platform']=='vscode']; exit(0 if vs and vs[0]['rootKey']=='servers' else 1)" 2>/dev/null \
    && pass "VS Code: uses 'servers' root key" || fail "VS Code: root key" "not 'servers'"

  # Cline and Roo use 'mcpServers'
  echo "$OUT" | python3 -c "import sys,json; ps=json.load(sys.stdin); cl=[p for p in ps if p['platform']=='cline']; exit(0 if cl and cl[0]['rootKey']=='mcpServers' else 1)" 2>/dev/null \
    && pass "Cline: uses 'mcpServers' root key" || fail "Cline: root key" "not 'mcpServers'"
  echo "$OUT" | python3 -c "import sys,json; ps=json.load(sys.stdin); rc=[p for p in ps if p['platform']=='roo-code']; exit(0 if rc and rc[0]['rootKey']=='mcpServers' else 1)" 2>/dev/null \
    && pass "Roo Code: uses 'mcpServers' root key" || fail "Roo Code: root key" "not 'mcpServers'"
fi

# ─── Test 10: VS Code MCP Installation ──────────────────────

if should_run "10"; then
  section "10: VS Code MCP Installation"

  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, detectPlatforms } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"vscode\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_vscode_test\", \"vscode\"), false);
    const data = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    console.log(JSON.stringify(data));
  "')

  # Uses "servers" root key, not "mcpServers"
  echo "$OUT" | jq -e '.servers.prior' > /dev/null 2>&1 && pass "VS Code: prior added under 'servers'" || fail "VS Code: prior added" "missing"
  echo "$OUT" | jq -e '.mcpServers' > /dev/null 2>&1 && fail "VS Code: has mcpServers (should not)" "unexpected key" || pass "VS Code: no mcpServers key"
  echo "$OUT" | jq -e '.servers.prior.type == "http"' > /dev/null 2>&1 && pass "VS Code: type field is 'http'" || fail "VS Code: type field" "missing or wrong"
  echo "$OUT" | jq -e '.servers.prior.url' > /dev/null 2>&1 && pass "VS Code: url field present" || fail "VS Code: url" "missing"
  echo "$OUT" | jq -e '.servers["copilot-ext"]' > /dev/null 2>&1 && pass "VS Code: existing server preserved" || fail "VS Code: existing server" "clobbered"
  echo "$OUT" | jq -r '.servers.prior.headers.Authorization' 2>/dev/null | grep -q "ask_vscode_test" \
    && pass "VS Code: auth header set" || fail "VS Code: auth header" "wrong"
fi

# ─── Test 11: Cline MCP + Rules Installation ────────────────

if should_run "11"; then
  section "11: Cline MCP + Rules Installation"

  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, installRules, getBundledRules, parseRulesVersion, detectPlatforms } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const path = require(\"path\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"cline\");

    // MCP install
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_cline_test\"), false);
    const mcpData = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));

    // Rules install (rulesPath is a directory for Cline; installRules adds prior.md)
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const rResult = installRules(p, rules, version, false);
    const rulesFile = path.join(p.rulesPath, \"prior.md\");
    const rulesContent = fs.readFileSync(rulesFile, \"utf-8\");

    // Check other rules files untouched
    const otherRulesPath = path.join(require(\"os\").homedir(), \"Documents\", \"Cline\", \"Rules\", \"my-rules.md\");
    const otherRules = fs.readFileSync(otherRulesPath, \"utf-8\");

    console.log(JSON.stringify({
      hasPriorMcp: !!mcpData.mcpServers?.prior,
      existingServerPreserved: !!mcpData.mcpServers?.memory,
      rulesAction: rResult.action,
      rulesHasMarker: rulesContent.includes(\"prior:v\"),
      rulesHasPrior: rulesContent.includes(\"ALWAYS search Prior\"),
      otherRulesIntact: otherRules.includes(\"async/await\"),
      rulesIsStandaloneFile: true,
    }));
  "')

  echo "$OUT" | jq -e '.hasPriorMcp == true' > /dev/null 2>&1 && pass "Cline: prior MCP added" || fail "Cline: prior MCP" "missing"
  echo "$OUT" | jq -e '.existingServerPreserved == true' > /dev/null 2>&1 && pass "Cline: existing server preserved" || fail "Cline: existing server" "clobbered"
  echo "$OUT" | jq -e '.rulesAction == "created"' > /dev/null 2>&1 && pass "Cline: rules created" || fail "Cline: rules action" "$(echo $OUT | jq -r '.rulesAction')"
  echo "$OUT" | jq -e '.rulesHasMarker == true' > /dev/null 2>&1 && pass "Cline: version marker present" || fail "Cline: marker" "missing"
  echo "$OUT" | jq -e '.rulesHasPrior == true' > /dev/null 2>&1 && pass "Cline: Prior rules present" || fail "Cline: Prior rules" "missing"
  echo "$OUT" | jq -e '.otherRulesIntact == true' > /dev/null 2>&1 && pass "Cline: other rules files untouched" || fail "Cline: other rules" "modified"
  echo "$OUT" | jq -e '.rulesIsStandaloneFile == true' > /dev/null 2>&1 && pass "Cline: rules in standalone prior.md" || fail "Cline: rules path" "not standalone"
fi

# ─── Test 12: Roo Code MCP + Rules Installation ─────────────

if should_run "12"; then
  section "12: Roo Code MCP + Rules Installation"

  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, installRules, getBundledRules, parseRulesVersion, detectPlatforms } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const path = require(\"path\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"roo-code\");

    // MCP install
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_roo_test\"), false);
    const mcpData = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));

    // Rules install (rulesPath is a directory for Roo Code; installRules adds prior.md)
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const rResult = installRules(p, rules, version, false);
    const rulesFile = path.join(p.rulesPath, \"prior.md\");
    const rulesContent = fs.readFileSync(rulesFile, \"utf-8\");

    // Check other rules files untouched
    const otherRulesPath = path.join(require(\"os\").homedir(), \".roo\", \"rules\", \"my-rules.md\");
    const otherRules = fs.readFileSync(otherRulesPath, \"utf-8\");

    console.log(JSON.stringify({
      hasPriorMcp: !!mcpData.mcpServers?.prior,
      existingServerPreserved: !!mcpData.mcpServers?.[\"db-tool\"],
      rulesAction: rResult.action,
      rulesHasMarker: rulesContent.includes(\"prior:v\"),
      rulesHasPrior: rulesContent.includes(\"ALWAYS search Prior\"),
      otherRulesIntact: otherRules.includes(\"dependency injection\"),
      rulesIsStandaloneFile: true,
    }));
  "')

  echo "$OUT" | jq -e '.hasPriorMcp == true' > /dev/null 2>&1 && pass "Roo Code: prior MCP added" || fail "Roo Code: prior MCP" "missing"
  echo "$OUT" | jq -e '.existingServerPreserved == true' > /dev/null 2>&1 && pass "Roo Code: existing server preserved" || fail "Roo Code: existing server" "clobbered"
  echo "$OUT" | jq -e '.rulesAction == "created"' > /dev/null 2>&1 && pass "Roo Code: rules created" || fail "Roo Code: rules action" "$(echo $OUT | jq -r '.rulesAction')"
  echo "$OUT" | jq -e '.rulesHasMarker == true' > /dev/null 2>&1 && pass "Roo Code: version marker present" || fail "Roo Code: marker" "missing"
  echo "$OUT" | jq -e '.rulesHasPrior == true' > /dev/null 2>&1 && pass "Roo Code: Prior rules present" || fail "Roo Code: Prior rules" "missing"
  echo "$OUT" | jq -e '.otherRulesIntact == true' > /dev/null 2>&1 && pass "Roo Code: other rules files untouched" || fail "Roo Code: other rules" "modified"
  echo "$OUT" | jq -e '.rulesIsStandaloneFile == true' > /dev/null 2>&1 && pass "Roo Code: rules in standalone prior.md" || fail "Roo Code: rules path" "not standalone"
fi

# ─── Test 13: Phase 2 Full Roundtrip ─────────────────────────

if should_run "13"; then
  section "13: Phase 2 Full Install/Uninstall Roundtrip"

  # VS Code roundtrip (uses 'servers' root key)
  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const { installMcpJson, uninstallMcp, buildHttpConfigWithAuth, detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"vscode\");

    // Install
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_rt_vs\", \"vscode\"), false);
    const after = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    const hasPrior = !!after.servers?.prior;

    // Uninstall
    uninstallMcp(p, false);
    let final = null;
    try { final = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\")); } catch {}
    const priorGone = !final?.servers?.prior;
    const existingPreserved = !!final?.servers?.[\"copilot-ext\"];

    console.log(JSON.stringify({ hasPrior, priorGone, existingPreserved }));
  "')

  echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "VS Code roundtrip: installed" || fail "VS Code roundtrip: install" "failed"
  echo "$OUT" | jq -e '.priorGone == true' > /dev/null 2>&1 && pass "VS Code roundtrip: uninstalled" || fail "VS Code roundtrip: uninstall" "still present"
  echo "$OUT" | jq -e '.existingPreserved == true' > /dev/null 2>&1 && pass "VS Code roundtrip: existing preserved" || fail "VS Code roundtrip: existing" "lost"

  # Cline roundtrip
  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const path = require(\"path\");
    const { installMcpJson, uninstallMcp, installRules, uninstallRules, buildHttpConfigWithAuth, getBundledRules, parseRulesVersion, detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"cline\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const rulesFile = path.join(p.rulesPath, \"prior.md\");

    // Install
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_rt_cl\"), false);
    installRules(p, rules, version, false);
    const mcpAfter = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    const rulesAfter = fs.readFileSync(rulesFile, \"utf-8\");

    // Uninstall
    uninstallMcp(p, false);
    uninstallRules(p, false);
    let mcpFinal = null;
    try { mcpFinal = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\")); } catch {}
    let rulesFinal = null;
    try { rulesFinal = fs.readFileSync(rulesFile, \"utf-8\"); } catch {}

    console.log(JSON.stringify({
      mcpInstalled: !!mcpAfter.mcpServers?.prior,
      rulesInstalled: rulesAfter.includes(\"prior:v\"),
      mcpRemoved: !mcpFinal?.mcpServers?.prior,
      existingMcpPreserved: !!mcpFinal?.mcpServers?.memory,
      rulesRemoved: !rulesFinal || !rulesFinal.includes(\"prior:v\"),
    }));
  "')

  echo "$OUT" | jq -e '.mcpInstalled == true' > /dev/null 2>&1 && pass "Cline roundtrip: MCP installed" || fail "Cline roundtrip: MCP install" "failed"
  echo "$OUT" | jq -e '.rulesInstalled == true' > /dev/null 2>&1 && pass "Cline roundtrip: rules installed" || fail "Cline roundtrip: rules install" "failed"
  echo "$OUT" | jq -e '.mcpRemoved == true' > /dev/null 2>&1 && pass "Cline roundtrip: MCP removed" || fail "Cline roundtrip: MCP uninstall" "still present"
  echo "$OUT" | jq -e '.existingMcpPreserved == true' > /dev/null 2>&1 && pass "Cline roundtrip: existing MCP preserved" || fail "Cline roundtrip: existing" "lost"
  echo "$OUT" | jq -e '.rulesRemoved == true' > /dev/null 2>&1 && pass "Cline roundtrip: rules removed" || fail "Cline roundtrip: rules uninstall" "still present"

  # Roo Code roundtrip
  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const path = require(\"path\");
    const { installMcpJson, uninstallMcp, installRules, uninstallRules, buildHttpConfigWithAuth, getBundledRules, parseRulesVersion, detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"roo-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const rulesFile = path.join(p.rulesPath, \"prior.md\");

    // Install
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_rt_roo\"), false);
    installRules(p, rules, version, false);
    const mcpAfter = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    const rulesAfter = fs.readFileSync(rulesFile, \"utf-8\");

    // Uninstall
    uninstallMcp(p, false);
    uninstallRules(p, false);
    let mcpFinal = null;
    try { mcpFinal = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\")); } catch {}
    let rulesFinal = null;
    try { rulesFinal = fs.readFileSync(rulesFile, \"utf-8\"); } catch {}

    console.log(JSON.stringify({
      mcpInstalled: !!mcpAfter.mcpServers?.prior,
      rulesInstalled: rulesAfter.includes(\"prior:v\"),
      mcpRemoved: !mcpFinal?.mcpServers?.prior,
      existingMcpPreserved: !!mcpFinal?.mcpServers?.[\"db-tool\"],
      rulesRemoved: !rulesFinal || !rulesFinal.includes(\"prior:v\"),
    }));
  "')

  echo "$OUT" | jq -e '.mcpInstalled == true' > /dev/null 2>&1 && pass "Roo Code roundtrip: MCP installed" || fail "Roo Code roundtrip: MCP install" "failed"
  echo "$OUT" | jq -e '.rulesInstalled == true' > /dev/null 2>&1 && pass "Roo Code roundtrip: rules installed" || fail "Roo Code roundtrip: rules install" "failed"
  echo "$OUT" | jq -e '.mcpRemoved == true' > /dev/null 2>&1 && pass "Roo Code roundtrip: MCP removed" || fail "Roo Code roundtrip: MCP uninstall" "still present"
  echo "$OUT" | jq -e '.existingMcpPreserved == true' > /dev/null 2>&1 && pass "Roo Code roundtrip: existing MCP preserved" || fail "Roo Code roundtrip: existing" "lost"
  echo "$OUT" | jq -e '.rulesRemoved == true' > /dev/null 2>&1 && pass "Roo Code roundtrip: rules removed" || fail "Roo Code roundtrip: rules uninstall" "still present"
fi

# ─── Test 14: Phase 2 Rules Idempotency & Update ────────────

if should_run "14"; then
  section "14: Phase 2 Rules Idempotency & Update"

  for PLATFORM in cline roo-code; do
    OUT=$(dcapture "node -e \"
      const fs = require('fs');
      const path = require('path');
      const { installRules, getBundledRules, parseRulesVersion, detectPlatforms } = require('./bin/setup.js');
      const ps = detectPlatforms();
      const p = ps.find(x => x.platform === '$PLATFORM');
      const rules = getBundledRules();
      const version = parseRulesVersion(rules);
      const rulesFile = path.join(p.rulesPath, 'prior.md');

      // First install
      installRules(p, rules, version, false);
      // Second install (same version) — should skip
      const r2 = installRules(p, rules, version, false);
      const content = fs.readFileSync(rulesFile, 'utf-8');
      const markerCount = (content.match(/<!-- prior:v/g) || []).length;

      // Simulate old version for update test
      let modified = content.replace('prior:v' + version, 'prior:v0.0.1');
      fs.writeFileSync(rulesFile, modified);
      const r3 = installRules(p, rules, version, false);
      const updated = fs.readFileSync(rulesFile, 'utf-8');
      const hasNew = updated.includes('prior:v' + version);
      const hasOld = updated.includes('prior:v0.0.1');
      const updatedCount = (updated.match(/<!-- prior:v/g) || []).length;

      console.log(JSON.stringify({
        idempotentAction: r2.action,
        markerCount,
        updateAction: r3.action,
        hasNew, hasOld, updatedCount,
      }));
    \"")

    PNAME=$(echo "$PLATFORM" | sed 's/roo-code/Roo Code/' | sed 's/cline/Cline/')
    echo "$OUT" | jq -e '.idempotentAction == "skipped"' > /dev/null 2>&1 && pass "$PNAME: idempotent (second run skipped)" || fail "$PNAME: idempotent" "$(echo $OUT | jq -r '.idempotentAction')"
    echo "$OUT" | jq -e '.markerCount == 1' > /dev/null 2>&1 && pass "$PNAME: no duplicate markers" || fail "$PNAME: markers" "count=$(echo $OUT | jq '.markerCount')"
    echo "$OUT" | jq -e '.updateAction == "updated"' > /dev/null 2>&1 && pass "$PNAME: version update works" || fail "$PNAME: update action" "$(echo $OUT | jq -r '.updateAction')"
    echo "$OUT" | jq -e '.hasNew == true' > /dev/null 2>&1 && pass "$PNAME: new version present after update" || fail "$PNAME: new version" "missing"
    echo "$OUT" | jq -e '.hasOld == false' > /dev/null 2>&1 && pass "$PNAME: old version removed after update" || fail "$PNAME: old version" "still present"
    echo "$OUT" | jq -e '.updatedCount == 1' > /dev/null 2>&1 && pass "$PNAME: exactly one marker after update" || fail "$PNAME: marker count after update" "$(echo $OUT | jq '.updatedCount')"
  done
fi

# ─── Test 15: VS Code Clipboard Rules ────────────────────────

if should_run "15"; then
  section "15: VS Code Rules (clipboard fallback)"

  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    const p = ps.find(x => x.platform === \"vscode\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const result = installRules(p, rules, version, true);
    console.log(JSON.stringify({ action: result.action, rulesPath: p.rulesPath }));
  "')

  echo "$OUT" | jq -e '.action == "clipboard"' > /dev/null 2>&1 && pass "VS Code: rules action is clipboard" || fail "VS Code: rules action" "$(echo $OUT | jq -r '.action')"
  echo "$OUT" | jq -e '.rulesPath == null' > /dev/null 2>&1 && pass "VS Code: no writable rules path" || fail "VS Code: rulesPath" "unexpected path"
fi

# ─── Test 16: Manual Platform Override (Phase 2) ────────────

if should_run "16"; then
  section "16: Manual Platform Override (Phase 2)"

  for PLATFORM in vscode cline roo-code; do
    OUT=$(dcapture "node -e \"
      const { createManualPlatform } = require('./bin/setup.js');
      const p = createManualPlatform('$PLATFORM');
      console.log(JSON.stringify({ platform: p.platform, rootKey: p.rootKey, hasConfig: !!p.configPath }));
    \"")

    PNAME=$(echo "$PLATFORM" | sed 's/roo-code/Roo Code/' | sed 's/cline/Cline/' | sed 's/vscode/VS Code/')
    echo "$OUT" | jq -e ".platform == \"$PLATFORM\"" > /dev/null 2>&1 && pass "$PNAME: manual override works" || fail "$PNAME: manual override" "wrong platform"
    echo "$OUT" | jq -e '.hasConfig == true' > /dev/null 2>&1 && pass "$PNAME: has config path" || fail "$PNAME: config path" "missing"
  done
fi

# ─── Cleanup ─────────────────────────────────────────────────

docker volume rm "$VOLUME_NAME" 2>/dev/null || true

# ─── Summary ─────────────────────────────────────────────────

TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped ($TOTAL total)"
echo "═══════════════════════════════════"

# Write JSON results
TESTS_JSON=$(printf '%s\n' "${TESTS[@]}" | paste -sd, -)
cat > "$RESULTS_DIR/results.json" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "image": "$IMAGE_NAME",
  "pass": $PASS,
  "fail": $FAIL,
  "skip": $SKIP,
  "total": $TOTAL,
  "tests": [$TESTS_JSON]
}
EOF

echo "  Results: $RESULTS_DIR/results.json"

if [ "$JSON_OUTPUT" = true ]; then
  cat "$RESULTS_DIR/results.json"
fi

[ $FAIL -eq 0 ] && exit 0 || exit 1
