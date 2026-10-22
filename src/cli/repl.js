import readline from 'node:readline';
import { execute, printResult, resolveScope } from './commands.js';
import { parseArgv } from './parser.js';
import { DtError, formatError } from '../errors.js';

export function tokenize(line) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of line.trim()) {
    if (escaped) { token += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else { token += character; started = true; }
  }
  if (quote) throw new Error('unterminated quote');
  if (escaped) token += '\\';
  if (started) tokens.push(token);
  return tokens;
}

export async function startRepl(args = []) {
  const parsed = parseArgv(['repl', ...args]);
  if (parsed.positionals.length || Object.keys(parsed.options).some((key) => !['session', 'task', 'json'].includes(key))) {
    throw new DtError('usage: dt repl [--session id] [--task id] [--json]', -32602);
  }
  const defaults = parsed.options;
  resolveScope(parsed, undefined, defaults);
  const repl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !defaults.json && Boolean(process.stdin.isTTY), prompt: 'dt> ' });
  const prompt = () => { if (!defaults.json && process.stdin.isTTY) repl.prompt(); };
  prompt();
  for await (const line of repl) {
    let argv;
    try { argv = tokenize(line); }
    catch (error) { process.stderr.write(formatError(error, defaults.json) + '\n'); prompt(); continue; }
    if (!argv.length) { prompt(); continue; }
    if (argv[0] === 'exit' || argv[0] === 'quit') break;
    const json = Boolean(defaults.json || argv.includes('--json'));
    try {
      if (argv[0] === 'help') printResult({ result: { ok: true, text: HELP }, json });
      else printResult(await execute(argv, undefined, defaults));
    } catch (error) {
      process.stderr.write(formatError(error, json) + '\n');
    }
    prompt();
  }
}

export const HELP = `Usage: dt <command> [arguments] [options]

Connection: launch, connect [port], disconnect, status, kill
Extension:  extension info|install, connect --extension (existing ordinary Chrome tabs)
Observe:    snapshot [--image], shot [file], title, url
Tabs:       tabs, use <id> [--activate], new [url]
Navigate:   goto <url>, reload, back
Network:    reqs [filter], req <n>, res <n>, har [file], reqclear
Actions:    click, dblclick, type, fill, select, wait, waitms
Inject:     eval <js>, ls <selector>, ck get|set|clear, ls get|set
Other:      overlay on|off, run <script.js>, repl, install-skill

Global options: --json --session <id> --task <id>
repl inherits these options; per-line scope options override them for one command.
use --activate explicitly shows the tab; new tabs are created in the background.
launch: --port <n> --profile <dir> --headless
Actions/navigation: --timeout <ms>; type: --delay <ms>
kill clears current scope; --session [id] clears a session; --daemon stops daemon.
kill --daemon --browser also closes the Chrome launched by dt.
snapshot refs can be used as selectors. Commands use a dedicated tab by default.
Chrome attach example:
  chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.dt-chrome"`;
