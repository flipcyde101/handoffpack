import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.js';
import { buildHandoffPack, verifyHandoffRepo } from '../src/handoffpack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'handoffpack.js');
const EM_DASH_CHAR = String.fromCharCode(0x2014);

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoffpack-test-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'demo-service',
        version: '1.2.3',
        type: 'module',
        scripts: {
          test: 'node --test',
          lint: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const value = 1;\n', 'utf8');

  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'feat: initial commit']);

  return dir;
}

test('CLI --help and --version work via bin entrypoint', () => {
  const helpOut = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.match(helpOut, /handoffpack v0\.1\.0/);
  assert.match(helpOut, /handoffpack build/);
  assert.match(helpOut, /handoffpack verify/);

  const verOut = execFileSync(process.execPath, [BIN_PATH, '--version'], { encoding: 'utf8' });
  assert.equal(verOut.trim(), '0.1.0');
});

test('build generates Markdown, --json, and --out handoff pack from git repo state', async (t) => {
  const repoDir = createTempGitRepo();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoffpack-out-'));
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // Modify tracked file and create untracked file
  fs.writeFileSync(
    path.join(repoDir, 'src', 'index.js'),
    'export const value = 2;\nexport const extra = true;\n',
    'utf8',
  );
  fs.writeFileSync(path.join(repoDir, 'NOTES.txt'), 'draft notes\n', 'utf8');

  // 1. Direct Markdown output via CLI
  const mdLogs = [];
  const mdExit = await runCli(
    [
      'build',
      repoDir,
      '--target',
      'antigravity',
      '--task',
      'Finish wiring telemetry exporter',
    ],
    { stdout: (m) => mdLogs.push(m) },
  );
  assert.equal(mdExit, 0);
  const md = mdLogs.join('\n');
  assert.match(md, /# Handoff Pack: demo-service \(Target: Antigravity\)/);
  assert.match(md, /Finish wiring telemetry exporter/);
  assert.match(md, /feat: initial commit/);
  assert.match(md, /src\/index\.js/);
  assert.match(md, /NOTES\.txt/);
  assert.match(md, /npm\.cmd test/);
  assert.match(md, /npm\.cmd run lint/);
  assert.match(md, /npm\.cmd run build/);
  assert.match(md, /Workspace Guardrails/);

  // 2. --json and --out file output
  const outFile = path.join(outDir, 'handoff.md');
  const jsonLogs = [];
  const jsonExit = await runCli(
    ['build', repoDir, '--target', 'claude', '--out', outFile, '--json'],
    { stdout: (m) => jsonLogs.push(m) },
  );
  assert.equal(jsonExit, 0);
  const parsed = JSON.parse(jsonLogs.join('\n'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target, 'claude');
  assert.equal(parsed.repo.branch, 'main');
  assert.equal(parsed.repo.headSha.length, 40);
  assert.equal(parsed.repo.clean, false);
  assert.ok(parsed.repo.modifiedFiles.includes('src/index.js'));
  assert.ok(parsed.repo.modifiedFiles.includes('NOTES.txt'));
  assert.match(parsed.repo.diffStat, /src\/index\.js/);
  assert.equal(parsed.repo.packageScripts.test, 'node --test');
  assert.ok(parsed.verificationCommands.includes('npm.cmd test'));
  assert.equal(fs.existsSync(outFile), true);
  assert.match(fs.readFileSync(outFile, 'utf8'), /Target: Claude Code/);
});

test('build rejects unknown --target values cleanly', async (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const errs = [];
  const code = await runCli(['build', repoDir, '--target', 'unknown-agent'], {
    stderr: (m) => errs.push(m),
  });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /Invalid --target/);
});

test('verify checks --expect-clean pass/fail and executes --cmd verification', async (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  // Clean repo + passing command -> exit 0
  const cleanLogs = [];
  const cleanExit = await runCli(
    [
      'verify',
      repoDir,
      '--expect-clean',
      '--cmd',
      'node -e "console.log(12345)"',
      '--json',
    ],
    { stdout: (m) => cleanLogs.push(m) },
  );
  assert.equal(cleanExit, 0);
  const cleanReport = JSON.parse(cleanLogs.join('\n'));
  assert.equal(cleanReport.ok, true);
  assert.equal(cleanReport.clean, true);
  assert.equal(cleanReport.commandResult.passed, true);
  assert.match(cleanReport.commandResult.stdout, /12345/);

  // Dirty repo with --expect-clean -> exit 1
  fs.writeFileSync(path.join(repoDir, 'dirty.tmp'), 'untracked\n', 'utf8');
  const dirtyLogs = [];
  const dirtyExit = await runCli(['verify', repoDir, '--expect-clean', '--json'], {
    stdout: (m) => dirtyLogs.push(m),
  });
  assert.equal(dirtyExit, 1);
  const dirtyReport = JSON.parse(dirtyLogs.join('\n'));
  assert.equal(dirtyReport.ok, false);
  assert.equal(dirtyReport.clean, false);
  assert.equal(dirtyReport.cleanPassed, false);
  assert.ok(dirtyReport.modifiedFiles.includes('dirty.tmp'));

  // Clean up dirty file, then verify failing --cmd -> exit 1
  fs.rmSync(path.join(repoDir, 'dirty.tmp'));
  const failCmdReport = verifyHandoffRepo({
    repoDir,
    expectClean: true,
    cmd: 'node -e "process.exit(2)"',
  });
  assert.equal(failCmdReport.ok, false);
  assert.equal(failCmdReport.cleanPassed, true);
  assert.equal(failCmdReport.commandResult.passed, false);
  assert.equal(failCmdReport.commandResult.exitCode, 2);
});

test('repository contains zero U+2014 em dashes across all tracked files', () => {
  const offenders = [];

  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes(EM_DASH_CHAR)) {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }

  scan(REPO_ROOT);
  assert.deepEqual(offenders, [], `Found U+2014 em dash in: ${offenders.join(', ')}`);
});
