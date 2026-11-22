import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildHandoffPack, verifyHandoffRepo } from './handoffpack.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));

export const HELP_TEXT = `handoffpack v${pkg.version}
Generate structured Git repo handoff prompts and verify post-handoff state.

Usage:
  handoffpack build [repoDir] [--target codex|antigravity|claude] [--task <text>] [--out <file>] [--json]
  handoffpack verify [repoDir] [--expect-clean] [--cmd <testCmd>] [--json]
  handoffpack --help | --version

Commands:
  build    Inspect a Git repository and emit a copy-paste Markdown (or JSON)
           handoff pack with Windows .cmd verification commands and guardrails.
  verify   Verify post-handoff working tree cleanliness and optional test command.

Options:
  --target <agent>   Target agent profile: codex (default), antigravity, claude
  --task <text>      Task summary to embed in the handoff prompt
  --out <file>       Write handoff output to file path
  --expect-clean     Fail verify if git working tree has uncommitted/untracked files
  --cmd <command>    Run verification shell command inside repoDir during verify
  --json             Emit structured JSON output
  -h, --help         Show help
  -v, --version      Show version
`;

function formatVerifyHuman(report) {
  const lines = [];
  lines.push(`Verify: ${report.repoDir} (${report.branch} @ ${report.headSha.slice(0, 7)})`);
  lines.push(
    `Working tree: ${report.clean ? 'CLEAN' : `DIRTY (${report.modifiedFiles.length} file(s))`}${
      report.expectClean ? (report.cleanPassed ? ' [PASS]' : ' [FAIL --expect-clean]') : ''
    }`,
  );
  if (!report.clean && report.modifiedFiles.length > 0) {
    for (const file of report.modifiedFiles) {
      lines.push(`  - ${file}`);
    }
  }
  if (report.commandResult) {
    const c = report.commandResult;
    lines.push(
      `Command "${c.command}": ${c.passed ? 'PASS' : 'FAIL'} (exit ${c.exitCode}, ${c.durationMs}ms)`,
    );
    if (!c.passed && c.stderr) {
      lines.push(c.stderr);
    }
  }
  lines.push(`Result: ${report.ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || ((msg) => process.stdout.write(`${msg}\n`));
  const stderr = io.stderr || ((msg) => process.stderr.write(`${msg}\n`));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        target: { type: 'string' },
        task: { type: 'string' },
        out: { type: 'string' },
        'expect-clean': { type: 'boolean', default: false },
        cmd: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    stderr(`Error: ${err.message}`);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    stdout(pkg.version);
    return 0;
  }

  const command = positionals[0];
  if (values.help || !command || command === 'help') {
    stdout(HELP_TEXT.trimEnd());
    return 0;
  }

  try {
    if (command === 'build') {
      const repoDir = positionals[1] || process.cwd();
      const pack = buildHandoffPack({
        repoDir,
        target: values.target || 'codex',
        task: values.task,
      });

      let outFile = null;
      if (values.out) {
        outFile = path.resolve(values.out);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const filePayload =
          values.json && outFile.toLowerCase().endsWith('.json')
            ? `${JSON.stringify(pack, null, 2)}\n`
            : pack.markdown;
        fs.writeFileSync(outFile, filePayload, 'utf8');
      }

      if (values.json) {
        stdout(JSON.stringify(outFile ? { ...pack, outFile } : pack, null, 2));
      } else if (outFile) {
        stdout(`Wrote handoff pack (${pack.target}) to ${outFile}`);
      } else {
        stdout(pack.markdown.trimEnd());
      }
      return 0;
    }

    if (command === 'verify') {
      const repoDir = positionals[1] || process.cwd();
      const report = verifyHandoffRepo({
        repoDir,
        expectClean: values['expect-clean'],
        cmd: values.cmd,
      });

      if (values.json) {
        stdout(JSON.stringify(report, null, 2));
      } else {
        stdout(formatVerifyHuman(report));
      }
      return report.ok ? 0 : 1;
    }

    stderr(`Error: Unknown command "${command}". Run "handoffpack --help" for usage.`);
    return 1;
  } catch (err) {
    if (values.json) {
      stdout(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      stderr(`Error: ${err.message}`);
    }
    return 1;
  }
}
