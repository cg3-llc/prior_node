const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const { parseArgs, expandNudgeTokens } = require('../bin/prior.js');
const CLI = path.join(__dirname, '..', 'bin', 'prior.js');

function run(args = '', input = null) {
  const opts = { encoding: 'utf-8', env: { ...process.env, PRIOR_API_KEY: 'test_key_123', PRIOR_BASE_URL: 'http://localhost:99999' }, timeout: 5000 };
  if (input !== null) opts.input = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [CLI, ...args.split(/\s+/).filter(Boolean)], opts);
}

// ============ parseArgs unit tests ============

describe('parseArgs', () => {
  it('positional args go to _', () => {
    const r = parseArgs(['search', 'hello', 'world']);
    assert.deepStrictEqual(r._, ['search', 'hello', 'world']);
  });

  it('--flag value parsed correctly', () => {
    const r = parseArgs(['--title', 'my title']);
    assert.strictEqual(r.title, 'my title');
  });

  it('--flag without value becomes true', () => {
    const r = parseArgs(['--json']);
    assert.strictEqual(r.json, true);
  });

  it('--flag before another --flag becomes true', () => {
    const r = parseArgs(['--json', '--verbose']);
    assert.strictEqual(r.json, true);
    assert.strictEqual(r.verbose, true);
  });

  it('--kebab-case converted to camelCase', () => {
    const r = parseArgs(['--max-results', '5']);
    assert.strictEqual(r.maxResults, '5');
  });

  it('--deeply-kebab-case converted', () => {
    const r = parseArgs(['--context-os', 'linux']);
    assert.strictEqual(r.contextOs, 'linux');
  });

  it('--help sets args.help = true', () => {
    const r = parseArgs(['--help']);
    assert.strictEqual(r.help, true);
  });

  it('-h sets args.help = true', () => {
    const r = parseArgs(['-h']);
    assert.strictEqual(r.help, true);
  });

  it('--error-messages collects multiple values', () => {
    const r = parseArgs(['--error-messages', 'err1', 'err2', 'err3', '--title', 'x']);
    assert.deepStrictEqual(r.errorMessages, ['err1', 'err2', 'err3']);
    assert.strictEqual(r.title, 'x');
  });

  it('--failed-approaches collects multiple values', () => {
    const r = parseArgs(['--failed-approaches', 'a1', 'a2']);
    assert.deepStrictEqual(r.failedApproaches, ['a1', 'a2']);
  });

  it('--error-messages single value still array', () => {
    const r = parseArgs(['--error-messages', 'only one']);
    assert.deepStrictEqual(r.errorMessages, ['only one']);
  });

  it('mixed positional and flags', () => {
    const r = parseArgs(['pos1', '--flag', 'val', 'pos2', '--bool']);
    assert.deepStrictEqual(r._, ['pos1', 'pos2']);
    assert.strictEqual(r.flag, 'val');
    assert.strictEqual(r.bool, true);
  });

  it('empty argv returns empty _ array', () => {
    const r = parseArgs([]);
    assert.deepStrictEqual(r._, []);
  });
});

// ============ Help text tests ============

describe('help text', () => {
  it('--help shows all subcommand names', () => {
    const r = run('--help');
    const out = r.stdout;
    for (const cmd of ['search', 'contribute', 'feedback', 'get', 'retract', 'status', 'credits', 'claim', 'verify']) {
      assert.ok(out.includes(cmd), `help should mention "${cmd}"`);
    }
  });

  it('--version outputs version string', () => {
    const r = run('--version');
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('-v outputs version string', () => {
    const r = run('-v');
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('no args shows help', () => {
    const r = run('');
    assert.ok(r.stdout.includes('Usage: prior'));
  });

  it('search --help shows search usage', () => {
    const r = run('search --help');
    assert.ok(r.stdout.includes('prior search'));
    assert.ok(r.stdout.includes('--max-results'));
  });

  it('contribute --help shows contribute usage', () => {
    const r = run('contribute --help');
    assert.ok(r.stdout.includes('--title'));
    assert.ok(r.stdout.includes('--content'));
    assert.ok(r.stdout.includes('--tags'));
  });

  it('feedback --help shows feedback usage', () => {
    const r = run('feedback --help');
    assert.ok(r.stdout.includes('prior feedback'));
    assert.ok(r.stdout.includes('useful'));
  });

  it('get --help shows get usage', () => {
    const r = run('get --help');
    assert.ok(r.stdout.includes('prior get'));
  });

  it('retract --help shows retract usage', () => {
    const r = run('retract --help');
    assert.ok(r.stdout.includes('prior retract'));
  });

  it('status --help shows status usage', () => {
    const r = run('status --help');
    assert.ok(r.stdout.includes('prior status'));
  });

  it('credits --help shows credits usage', () => {
    const r = run('credits --help');
    assert.ok(r.stdout.includes('prior credits'));
  });

  it('claim --help shows claim usage', () => {
    const r = run('claim --help');
    assert.ok(r.stdout.includes('prior claim'));
  });

  it('verify --help shows verify usage', () => {
    const r = run('verify --help');
    assert.ok(r.stdout.includes('prior verify'));
  });
});

// ============ Validation tests ============

describe('validation', () => {
  it('search with no query errors', () => {
    const r = run('search');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('search with short query errors', () => {
    const r = run('search short');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('too short'));
  });

  it('search with query exactly 10 chars succeeds (hits network)', () => {
    // 10-char query passes validation but will fail on network - that's fine
    const r = run('search 1234567890');
    // Should NOT have the "too short" error
    assert.ok(!r.stderr.includes('too short'));
  });

  it('contribute with missing fields errors', () => {
    const r = run('contribute');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Missing required'));
  });

  it('contribute with only title errors', () => {
    const r = run('contribute --title test');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Missing required'));
  });

  it('feedback with no args errors', () => {
    const r = run('feedback');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('feedback with only id errors', () => {
    const r = run('feedback k_abc123');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('get with no id errors', () => {
    const r = run('get');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('retract with no id errors', () => {
    const r = run('retract');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('claim with no email errors', () => {
    const r = run('claim');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('verify with no code errors', () => {
    const r = run('verify');
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Usage'));
  });

  it('unknown command shows error and help', () => {
    const r = run('notacommand');
    assert.ok(r.stderr.includes('Unknown command'));
    assert.ok(r.stdout.includes('Usage: prior'));
  });
});

// ============ Stdin JSON merge tests ============

describe('stdin contribute merge', () => {
  it('stdin JSON populates args when CLI flags absent', () => {
    const r = run('contribute', { title: 'T', content: 'C', tags: ['a', 'b'], model: 'gpt-4' });
    // Will try to hit network and fail, but should NOT say "Missing required"
    assert.ok(!r.stderr.includes('Missing required'), 'stdin fields should satisfy requirements');
  });

  it('CLI flags override stdin JSON', () => {
    const r = run('contribute --title CLITitle', { title: 'StdinTitle', content: 'C', tags: ['a'] });
    // Still missing content/tags from CLI but stdin provides them
    // The title should be CLITitle (CLI wins) - we can't verify directly but at least it shouldn't error on missing fields
    assert.ok(!r.stderr.includes('Missing required'));
  });

  it('stdin tags array joined to comma string', () => {
    // If tags are properly joined, contribute validation passes
    const r = run('contribute', { title: 'T', content: 'C', tags: ['tag1', 'tag2', 'tag3'] });
    assert.ok(!r.stderr.includes('Missing required'));
  });

  it('stdin effort object maps to effort fields', () => {
    const r = run('contribute', {
      title: 'T', content: 'C', tags: ['a'],
      effort: { tokensUsed: 1000, durationSeconds: 60, toolCalls: 5 }
    });
    assert.ok(!r.stderr.includes('Missing required'));
  });

  it('stdin environment object accepted', () => {
    const r = run('contribute', {
      title: 'T', content: 'C', tags: ['a'],
      environment: { language: 'python', os: 'linux' }
    });
    assert.ok(!r.stderr.includes('Missing required'));
  });

  it('stdin ttl accepted', () => {
    const r = run('contribute', {
      title: 'T', content: 'C', tags: ['a'], ttl: '30d'
    });
    assert.ok(!r.stderr.includes('Missing required'));
  });
});

describe('stdin feedback merge', () => {
  it('stdin entryId and outcome populate positional args', () => {
    const r = run('feedback', { entryId: 'k_abc123', outcome: 'useful' });
    // Should NOT say "Usage:" since args are provided via stdin
    assert.ok(!r.stderr.includes('Usage'));
  });

  it('stdin id field works as alternative to entryId', () => {
    const r = run('feedback', { id: 'k_abc123', outcome: 'useful' });
    assert.ok(!r.stderr.includes('Usage'));
  });

  it('positional args override stdin', () => {
    const r = run('feedback k_cli useful', { entryId: 'k_stdin', outcome: 'not_useful' });
    assert.ok(!r.stderr.includes('Usage'));
  });

  it('stdin correction object maps to correction fields', () => {
    const r = run('feedback', {
      entryId: 'k_abc', outcome: 'not_useful', reason: 'wrong',
      correction: { content: 'fixed', title: 'Fixed Title', tags: ['t1', 't2'] }
    });
    assert.ok(!r.stderr.includes('Usage'));
  });

  it('stdin with reason and notes accepted', () => {
    const r = run('feedback', {
      entryId: 'k_abc', outcome: 'not_useful', reason: 'outdated', notes: 'some note'
    });
    assert.ok(!r.stderr.includes('Usage'));
  });
});

// ============ Edge cases ============

describe('edge cases', () => {
  it('invalid JSON on stdin causes error', () => {
    const opts = { encoding: 'utf-8', input: 'not json{', env: { ...process.env, PRIOR_API_KEY: 'k', PRIOR_BASE_URL: 'http://localhost:99999' }, timeout: 5000 };
    const r = spawnSync(process.execPath, [CLI, 'contribute'], opts);
    assert.ok(r.status !== 0);
    assert.ok(r.stderr.includes('Invalid JSON'));
  });

  it('empty stdin treated as no input (TTY-like)', () => {
    const opts = { encoding: 'utf-8', input: '', env: { ...process.env, PRIOR_API_KEY: 'k', PRIOR_BASE_URL: 'http://localhost:99999' }, timeout: 5000 };
    const r = spawnSync(process.execPath, [CLI, 'contribute'], opts);
    // Should fail with missing required, not JSON error
    assert.ok(r.stderr.includes('Missing required'));
  });

  it('contribute with all CLI flags passes validation', () => {
    const r = run('contribute --title T --content C --tags a,b --model m');
    assert.ok(!r.stderr.includes('Missing required'));
  });

  it('contribute tags string not array from stdin', () => {
    const r = run('contribute', { title: 'T', content: 'C', tags: 'already,a,string' });
    assert.ok(!r.stderr.includes('Missing required'));
  });
});

// ============ expandNudgeTokens tests ============

describe('expandNudgeTokens', () => {
  it('expands [PRIOR:CONTRIBUTE] to prior contribute', () => {
    assert.strictEqual(
      expandNudgeTokens('Try [PRIOR:CONTRIBUTE] your fix.'),
      'Try `prior contribute` your fix.'
    );
  });

  it('expands [PRIOR:FEEDBACK] to prior feedback', () => {
    assert.strictEqual(
      expandNudgeTokens('Did it help? [PRIOR:FEEDBACK]'),
      'Did it help? `prior feedback`'
    );
  });

  it('expands parameterized contribute', () => {
    assert.strictEqual(
      expandNudgeTokens('[PRIOR:CONTRIBUTE problem="NPE" tags="kotlin"]'),
      '`prior contribute`'
    );
  });

  it('expands multiple tokens in one message', () => {
    const result = expandNudgeTokens('[PRIOR:CONTRIBUTE] or [PRIOR:FEEDBACK]');
    assert.ok(result.includes('`prior contribute`'));
    assert.ok(result.includes('`prior feedback`'));
    assert.ok(!result.includes('[PRIOR:'));
  });

  it('handles null/undefined gracefully', () => {
    assert.strictEqual(expandNudgeTokens(null), null);
    assert.strictEqual(expandNudgeTokens(undefined), undefined);
  });

  it('passes through message with no tokens unchanged', () => {
    const msg = 'No tokens here.';
    assert.strictEqual(expandNudgeTokens(msg), msg);
  });
});
