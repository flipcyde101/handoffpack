import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const VALID_TARGETS = ['codex', 'antigravity', 'claude'];

const TARGET_PROFILES = {
  codex: {
    label: 'Codex',
    guidance: [
      'Apply focused, minimal diffs directly in the repository workspace.',
      'Run Windows .cmd package shims (npm.cmd / npx.cmd) in PowerShell.',
      'Re-run the verification commands below before reporting completion.',
    ],
  },
  antigravity: {
    label: 'Antigravity',
    guidance: [
      'Keep context and tool calls surgical; avoid scanning unrelated directories.',
      'Use npm.cmd / npx.cmd in Windows PowerShell sessions.',
      'Verify all tests pass and check working tree state before concluding.',
    ],
  },
  claude: {
    label: 'Claude Code',
    guidance: [
      'Read modified files in full before applying edits to preserve surrounding logic.',
      'Invoke npm.cmd / npx.cmd when executing scripts from Windows PowerShell.',
      'Execute the verification suite and confirm exit code 0 prior to handoff.',
    ],
  },
};

function runGit(repoDir, args) {
  const res = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout || '').replace(/\r\n/g, '\n'),
    stderr: (res.stderr || '').replace(/\r\n/g, '\n'),
  };
}

function parsePorcelainStatus(rawStatus) {
  const trimmedEnd = rawStatus.replace(/\n+$/, '');
  if (!trimmedEnd) return [];

  const entries = [];
  for (const line of trimmedEnd.split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2).trim() || 'M';
    const rawFile = line.slice(3).trim();
    const arrowIdx = rawFile.indexOf(' -> ');
    const filePath = arrowIdx !== -1 ? rawFile.slice(arrowIdx + 4).trim() : rawFile;
    entries.push({ status, path: filePath, raw: line });
  }
  return entries;
}

function detectPackageInfo(repoDir) {
  const pkgPath = path.join(repoDir, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      pkg = null;
    }
  }

  let pmCmd = 'npm.cmd';
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml')) || pkg?.packageManager?.startsWith('pnpm')) {
    pmCmd = 'pnpm.cmd';
  } else if (
    fs.existsSync(path.join(repoDir, 'yarn.lock')) ||
    pkg?.packageManager?.startsWith('yarn')
  ) {
    pmCmd = 'yarn.cmd';
  }

  const scripts =
    pkg && pkg.scripts && typeof pkg.scripts === 'object' ? { ...pkg.scripts } : {};

  return {
    hasPackageJson: Boolean(pkg),
    name: pkg?.name || path.basename(repoDir),
    version: pkg?.version || null,
    pmCmd,
    scripts,
  };
}

function synthesizeVerificationCommands(repoDir, pkgInfo) {
  const commands = [];
  const { scripts, pmCmd } = pkgInfo;

  if (scripts.test) {
    if (scripts.test.trim() === 'node --test') {
      commands.push('node --test');
    }
    commands.push(`${pmCmd} test`);
  }

  for (const scriptName of ['lint', 'typecheck', 'check', 'build']) {
    if (scripts[scriptName]) {
      commands.push(`${pmCmd} run ${scriptName}`);
    }
  }

  if (commands.length === 0 && pkgInfo.hasPackageJson) {
    commands.push(`${pmCmd} test`);
  }

  commands.push('git status --short');
  commands.push('git diff --stat');

  return commands;
}

function buildGuardrails(repoDir) {
  return [
    `Scope all file reads/writes strictly within "${repoDir}".`,
    'Keep project artifacts, caches, and dependencies on the workspace drive (for example D:\\Codex\\Projects on Windows); never fall back to Desktop, OneDrive, or C: profile folders.',
    'Use .cmd shims (npm.cmd, npx.cmd, pnpm.cmd, yarn.cmd) in Windows PowerShell to avoid execution-policy .ps1 blocks.',
    'Preserve LF line endings (.gitattributes) and keep zero U+2014 em dashes across code, docs, and tests.',
    'Do not run git push or npm.cmd install -g unless explicitly requested by the user.',
    'Inspect uncommitted changes listed above before modifying shared files so in-progress work is not lost.',
  ];
}

export function inspectGitRepo(repoDirInput = process.cwd()) {
  const repoDir = path.resolve(repoDirInput);
  if (!fs.existsSync(repoDir)) {
    throw new Error(`Repository directory does not exist: ${repoDir}`);
  }

  const check = runGit(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (check.status !== 0 || check.stdout.trim() !== 'true') {
    throw new Error(`Not a git repository: ${repoDir}`);
  }

  const symBranch = runGit(repoDir, ['symbolic-ref', '--short', 'HEAD']);
  let branch = symBranch.status === 0 ? symBranch.stdout.trim() : '';
  if (!branch) {
    const revBranch = runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    branch = revBranch.status === 0 ? revBranch.stdout.trim() : 'HEAD';
  }

  const headRes = runGit(repoDir, ['rev-parse', 'HEAD']);
  const headSha = headRes.status === 0 ? headRes.stdout.trim() : 'unborn';
  const shortSha = headSha === 'unborn' ? 'unborn' : headSha.slice(0, 7);

  const recentCommits = [];
  if (headSha !== 'unborn') {
    const logRes = runGit(repoDir, ['log', '-n', '5', '--pretty=format:%h%x09%H%x09%s%x09%ci']);
    if (logRes.status === 0 && logRes.stdout.trim()) {
      for (const line of logRes.stdout.trim().split('\n')) {
        const [shortHash, fullHash, subject, date] = line.split('\t');
        recentCommits.push({
          shortSha: shortHash,
          sha: fullHash,
          subject: subject || '',
          date: date || '',
        });
      }
    }
  }

  const statusRes = runGit(repoDir, ['status', '--short']);
  const statusShort = statusRes.stdout.replace(/\n+$/, '');
  const statusEntries = parsePorcelainStatus(statusShort);
  const modifiedFiles = statusEntries.map((e) => e.path);

  let diffStat = '';
  if (headSha !== 'unborn') {
    const diffHead = runGit(repoDir, ['diff', '--stat', 'HEAD']);
    if (diffHead.status === 0) {
      diffStat = diffHead.stdout.trimEnd();
    }
  }
  if (!diffStat) {
    const diffPlain = runGit(repoDir, ['diff', '--stat']);
    if (diffPlain.status === 0) {
      diffStat = diffPlain.stdout.trimEnd();
    }
  }

  const pkgInfo = detectPackageInfo(repoDir);

  return {
    repoDir,
    name: pkgInfo.name,
    version: pkgInfo.version,
    branch,
    headSha,
    shortSha,
    clean: statusEntries.length === 0,
    recentCommits,
    statusShort,
    statusEntries,
    modifiedFiles,
    diffStat,
    packageManagerCmd: pkgInfo.pmCmd,
    packageScripts: pkgInfo.scripts,
    hasPackageJson: pkgInfo.hasPackageJson,
  };
}

export function renderHandoffMarkdown(pack) {
  const { repo, target, targetLabel, task, guidance, verificationCommands, guardrails } = pack;
  const lines = [];

  lines.push(`# Handoff Pack: ${repo.name} (Target: ${targetLabel})`);
  lines.push('');
  lines.push('## Task Objective');
  lines.push('');
  lines.push(task || '[Specify next engineering task here]');
  lines.push('');
  lines.push(`## Target Agent Notes (${target})`);
  lines.push('');
  for (const item of guidance) {
    lines.push(`- ${item}`);
  }

  lines.push('');
  lines.push('## Repository Snapshot');
  lines.push('');
  lines.push(`- **Workspace**: \`${repo.repoDir}\``);
  lines.push(`- **Branch**: \`${repo.branch}\``);
  lines.push(`- **HEAD SHA**: \`${repo.headSha}\` (\`${repo.shortSha}\`)`);
  lines.push(`- **Working Tree**: ${repo.clean ? 'Clean' : `Dirty (${repo.modifiedFiles.length} path(s))`}`);

  lines.push('');
  lines.push('### Recent Commits');
  lines.push('');
  if (repo.recentCommits.length === 0) {
    lines.push('_No commits yet._');
  } else {
    for (const c of repo.recentCommits) {
      lines.push(`- \`${c.shortSha}\` ${c.subject}`);
    }
  }

  lines.push('');
  lines.push('### Git Status (`git status --short`)');
  lines.push('');
  lines.push('```text');
  lines.push(repo.statusShort || '(clean working tree)');
  lines.push('```');

  lines.push('');
  lines.push('### Modified / Untracked Files');
  lines.push('');
  if (repo.modifiedFiles.length === 0) {
    lines.push('- None');
  } else {
    for (const entry of repo.statusEntries) {
      lines.push(`- \`${entry.status}\` \`${entry.path}\``);
    }
  }

  lines.push('');
  lines.push('### Diff Summary (`git diff --stat`)');
  lines.push('');
  lines.push('```text');
  lines.push(repo.diffStat || '(no tracked file diffs)');
  lines.push('```');

  lines.push('');
  lines.push('## Package Scripts (`package.json`)');
  lines.push('');
  const scriptEntries = Object.entries(repo.packageScripts);
  if (scriptEntries.length === 0) {
    lines.push('_No package.json scripts detected._');
  } else {
    for (const [name, scriptCmd] of scriptEntries) {
      lines.push(`- \`${name}\`: \`${scriptCmd}\``);
    }
  }

  lines.push('');
  lines.push('## Verification Commands (Windows PowerShell .cmd)');
  lines.push('');
  lines.push('```powershell');
  lines.push(`Set-Location '${repo.repoDir}'`);
  for (const cmd of verificationCommands) {
    lines.push(cmd);
  }
  lines.push('```');

  lines.push('');
  lines.push('## Workspace Guardrails');
  lines.push('');
  for (const rule of guardrails) {
    lines.push(`- ${rule}`);
  }
  lines.push('');

  return lines.join('\n');
}

export function buildHandoffPack(options = {}) {
  const repoDir = options.repoDir || process.cwd();
  const rawTarget = (options.target || 'codex').toLowerCase().trim();
  if (!VALID_TARGETS.includes(rawTarget)) {
    throw new Error(
      `Invalid --target "${options.target}". Expected one of: ${VALID_TARGETS.join(', ')}.`,
    );
  }

  const repo = inspectGitRepo(repoDir);
  const profile = TARGET_PROFILES[rawTarget];
  const verificationCommands = synthesizeVerificationCommands(repo.repoDir, {
    hasPackageJson: repo.hasPackageJson,
    pmCmd: repo.packageManagerCmd,
    scripts: repo.packageScripts,
  });
  const guardrails = buildGuardrails(repo.repoDir);
  const task = options.task ? options.task.trim() : null;

  const pack = {
    ok: true,
    target: rawTarget,
    targetLabel: profile.label,
    task,
    repo,
    guidance: profile.guidance,
    verificationCommands,
    guardrails,
    markdown: '',
  };

  pack.markdown = renderHandoffMarkdown(pack);
  return pack;
}

export function verifyHandoffRepo(options = {}) {
  const repoDir = options.repoDir || process.cwd();
  const expectClean = Boolean(options.expectClean);
  const cmd = options.cmd ? options.cmd.trim() : null;

  const repo = inspectGitRepo(repoDir);
  const cleanPassed = expectClean ? repo.clean : true;

  let commandResult = null;
  if (cmd) {
    const start = Date.now();
    const res = spawnSync(cmd, {
      cwd: repo.repoDir,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const durationMs = Date.now() - start;
    const exitCode = res.status ?? 1;
    commandResult = {
      command: cmd,
      exitCode,
      passed: exitCode === 0,
      durationMs,
      stdout: (res.stdout || '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: (res.stderr || '').replace(/\r\n/g, '\n').trimEnd(),
    };
  }

  const ok = cleanPassed && (!commandResult || commandResult.passed);

  return {
    ok,
    repoDir: repo.repoDir,
    branch: repo.branch,
    headSha: repo.headSha,
    expectClean,
    clean: repo.clean,
    cleanPassed,
    modifiedFiles: repo.modifiedFiles,
    statusShort: repo.statusShort,
    commandResult,
  };
}
