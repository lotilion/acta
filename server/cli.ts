// Finding and checking the subscription CLIs (claude, codex). The packaged app runs with
// Finder's minimal PATH, so the binaries are looked up in the usual install folders and,
// as a last resort, through the user's login shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function candidateDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'bin'),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }
  return [...new Set(dirs.filter(Boolean))];
}

const found = new Map<string, string>();

/** Absolute path of a CLI, or '' if it is not installed. Cached per run; refresh() clears it. */
export function findCli(cmd: 'claude' | 'codex'): string {
  const hit = found.get(cmd);
  if (hit !== undefined && (hit === '' || fs.existsSync(hit))) return hit;
  let result = '';
  const exe = process.platform === 'win32' ? `${cmd}.cmd` : cmd;
  for (const dir of candidateDirs()) {
    const p = path.join(dir, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      result = p;
      break;
    } catch { /* keep looking */ }
  }
  found.set(cmd, result);
  return result;
}

export function refreshCliCache() {
  found.clear();
}

async function loginShellWhich(cmd: string): Promise<string> {
  if (process.platform === 'win32') return '';
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await execFileP(shell, ['-lc', `command -v ${cmd}`], { timeout: 8000 });
    const p = stdout.trim().split('\n').pop() || '';
    return p && fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

export type CliStatus = {
  installed: boolean;
  path: string;
  version: string;
  /** true = session found, false = clearly missing, null = can't tell from outside */
  loggedIn: boolean | null;
};

async function version(bin: string): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, ['--version'], { timeout: 8000 });
    return stdout.trim().split('\n')[0].slice(0, 60);
  } catch {
    return '';
  }
}

function claudeLoggedIn(): boolean | null {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    if (/"oauthAccount"\s*:\s*\{/.test(cfg) || /"primaryApiKey"/.test(cfg)) return true;
  } catch { /* no config yet */ }
  if (fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))) return true;
  // On the Mac the token can live in the Keychain, invisible from here.
  return null;
}

function codexLoggedIn(): boolean | null {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    return !!(auth?.tokens || auth?.OPENAI_API_KEY || Object.keys(auth || {}).length);
  } catch {
    return false; // codex always writes auth.json on login
  }
}

export async function cliStatus(refresh = false): Promise<{ claude: CliStatus; codex: CliStatus }> {
  if (refresh) refreshCliCache();
  const out = {} as { claude: CliStatus; codex: CliStatus };
  for (const cmd of ['claude', 'codex'] as const) {
    let bin = findCli(cmd);
    if (!bin) {
      bin = await loginShellWhich(cmd);
      if (bin) found.set(cmd, bin);
    }
    out[cmd] = {
      installed: !!bin,
      path: bin,
      version: bin ? await version(bin) : '',
      loggedIn: bin ? (cmd === 'claude' ? claudeLoggedIn() : codexLoggedIn()) : false,
    };
  }
  return out;
}
