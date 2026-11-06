import { DtError } from '../errors.js';
import { validateCommand } from '../validation.js';

const VALUE_OPTIONS = new Set(['port', 'profile', 'session', 'task', 'timeout', 'delay']);
const BOOLEAN_OPTIONS = new Set(['json', 'image', 'daemon', 'browser', 'full-page', 'no-redact', 'headless', 'extension', 'activate', 'no-companion']);

export function parseArgv(argv) {
  const command = argv[0] || 'help';
  const options = {};
  const positionals = [];
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_OPTIONS.has(rawName)) {
      if (inline !== undefined) throw new DtError(`--${rawName} does not take a value`, -32602);
      options[rawName] = true;
    }
    else if (VALUE_OPTIONS.has(rawName)) {
      if (rawName === 'session' && command === 'kill' && inline === undefined && (argv[index + 1] === undefined || argv[index + 1].startsWith('--'))) options.session = true;
      else {
        const value = inline ?? argv[++index];
        if (value === undefined || value.startsWith('--')) throw new DtError(`--${rawName} requires a value`, -32602);
        options[rawName] = value;
      }
    } else throw new DtError(`unknown option: --${rawName}`);
  }
  return { command, options, positionals };
}

function requireArg(args, index, label) {
  if (args[index] === undefined) throw new DtError(`missing ${label}`);
  return args[index];
}

export function toRpcCommand(parsed) {
  const allowed = {
    launch: ['port', 'profile', 'headless', 'no-companion'], connect: ['port', 'extension', 'no-companion'], kill: ['daemon', 'browser'],
    goto: ['timeout'], open: ['timeout'], reload: ['timeout'], back: ['timeout'], new: ['timeout'], use: ['activate'],
    snapshot: ['image'], shot: ['full-page'], har: ['no-redact'],
    click: ['timeout'], dblclick: ['timeout'], fill: ['timeout'], select: ['timeout'], wait: ['timeout'], type: ['timeout', 'delay'],
  };
  for (const key of Object.keys(parsed.options)) {
    if (!['json', 'session', 'task', ...(allowed[parsed.command] || [])].includes(key)) {
      throw new DtError(`--${key} is not supported by ${parsed.command}`, -32602);
    }
  }
  const command = rawCommand(parsed);
  if (parsed.options.extension && (parsed.options.port || parsed.positionals.length)) throw new DtError('connect --extension cannot take a CDP port', -32602);
  const limits = { launch: 1, connect: 1, disconnect: 0, status: 0, kill: 0, tabs: 0, use: 1, new: 1,
    goto: 1, open: 1, finish: 0, reload: 0, back: 0, snapshot: 0, shot: 1, title: 0, url: 0, reqs: 1, req: 1, res: 1,
    har: 1, reqclear: 0, click: 1, dblclick: 1, type: 2, fill: 2, select: 2, wait: 1, waitms: 1,
    eval: 1, overlay: 1, companion: 1, run: 1, ck: 3, ls: 3 };
  if (parsed.positionals.length > limits[parsed.command]) throw new DtError('too many arguments', -32602);
  if (parsed.command === 'ls' && !['get', 'set'].includes(parsed.positionals[0]) && parsed.positionals.length > 1) throw new DtError('ls takes one selector', -32602);
  if (['ck', 'ls'].includes(parsed.command) && parsed.positionals[0] === 'get' && parsed.positionals.length > 2) throw new DtError('get takes at most one key', -32602);
  if (parsed.command === 'overlay' && !['on', 'off'].includes(parsed.positionals[0])) throw new DtError('overlay requires on or off', -32602);
  if (parsed.command === 'companion' && parsed.positionals.length && !['on', 'off'].includes(parsed.positionals[0])) throw new DtError('companion requires on or off', -32602);
  if (parsed.options['no-companion']) command[1].companion = false;
  validateCommand(...command);
  return command;
}

function rawCommand(parsed) {
  const { command, options: o, positionals: a } = parsed;
  const timeout = o.timeout === undefined ? undefined : Number(o.timeout);
  if (command === 'launch') return ['launch', { port: o.port || a[0] ? Number(o.port || a[0]) : undefined, profile: o.profile, ...(o.headless ? { headless: true } : {}) }];
  if (command === 'connect') return ['connect', { port: o.port || a[0] ? Number(o.port || a[0]) : undefined, ...(o.extension ? { extension: true } : {}) }];
  if (['reload', 'back'].includes(command)) return [command, { timeout }];
  if (['disconnect', 'status', 'tabs', 'title', 'url', 'reqclear', 'finish'].includes(command)) return [command, {}];
  if (command === 'kill') return ['kill', { daemon: Boolean(o.daemon), browser: Boolean(o.browser), session: o.session }];
  if (command === 'use') return ['use', { id: requireArg(a, 0, 'tab id'), ...(o.activate ? { activate: true } : {}) }];
  if (command === 'new') return ['new', { url: a[0] || 'about:blank', timeout }];
  if (['goto', 'open'].includes(command)) return [command, { url: requireArg(a, 0, 'url'), timeout }];
  if (command === 'snapshot') return ['snapshot', { image: Boolean(o.image) }];
  if (command === 'shot') return ['shot', { file: a[0], fullPage: Boolean(o['full-page']) }];
  if (command === 'reqs') return ['reqs', { filter: a[0] }];
  if (command === 'req' || command === 'res') return [command, { n: Number(requireArg(a, 0, 'request number')) }];
  if (command === 'har') return ['har', { file: a[0], redact: !o['no-redact'] }];
  if (command === 'click' || command === 'dblclick' || command === 'wait') return [command, { selector: requireArg(a, 0, 'selector'), timeout }];
  if (command === 'type' || command === 'fill') return [command, { selector: requireArg(a, 0, 'selector'), text: requireArg(a, 1, 'text'), timeout, delay: o.delay === undefined ? undefined : Number(o.delay) }];
  if (command === 'select') return ['select', { selector: requireArg(a, 0, 'selector'), value: requireArg(a, 1, 'value'), timeout }];
  if (command === 'waitms') return ['waitms', { ms: Number(requireArg(a, 0, 'milliseconds')) }];
  if (command === 'eval') return ['eval', { expression: requireArg(a, 0, 'JavaScript expression') }];
  if (command === 'overlay') return ['overlay', { enabled: requireArg(a, 0, 'on|off') === 'on' }];
  if (command === 'companion') return ['companion', a.length ? { enabled: a[0] === 'on' } : {}];
  if (command === 'run') return ['run', { file: requireArg(a, 0, 'script file') }];
  if (command === 'ck') {
    const operation = requireArg(a, 0, 'cookie operation');
    return [`ck.${operation}`, { key: a[1], value: a[2] }];
  }
  if (command === 'ls') {
    if (a[0] === 'get' || a[0] === 'set') return [`ls.${a[0]}`, { key: a[1], value: a[2] }];
    return ['ls.elements', { selector: requireArg(a, 0, 'selector') }];
  }
  throw new DtError(`unknown command: ${command}`, -32601);
}
