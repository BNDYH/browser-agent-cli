import { DtError } from './errors.js';

export const METHODS = new Set(['launch', 'connect', 'disconnect', 'status', 'kill', 'tabs', 'use', 'new', 'goto',
  'reload', 'back', 'snapshot', 'shot', 'title', 'url', 'reqs', 'req', 'res', 'har', 'reqclear',
  'click', 'dblclick', 'type', 'fill', 'select', 'wait', 'waitms', 'eval', 'ls.elements',
  'ck.get', 'ck.set', 'ck.clear', 'ls.get', 'ls.set', 'overlay', 'run']);

export function validateCommand(method, params = {}) {
  if (!METHODS.has(method)) throw new DtError(`unknown method: ${method}`, -32601);
  const bad = (message) => { throw new DtError(message, -32602); };
  if (!params || Array.isArray(params) || typeof params !== 'object') bad('params must be an object');
  const required = {
    use: ['id'], goto: ['url'], click: ['selector'], dblclick: ['selector'], type: ['selector', 'text'],
    fill: ['selector', 'text'], select: ['selector', 'value'], wait: ['selector'], eval: ['expression'],
    'ls.elements': ['selector'], 'ck.set': ['key', 'value'], 'ls.set': ['key', 'value'], run: ['file'],
  };
  for (const key of required[method] || []) {
    if (typeof params[key] !== 'string' || (!['text', 'value'].includes(key) && !params[key])) bad(`${key} is required`);
  }
  for (const [key, max] of [['port', 65535], ['timeout', 3_600_000], ['delay', 60_000], ['ms', 3_600_000], ['n', Number.MAX_SAFE_INTEGER]]) {
    const value = params[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (['ms', 'delay'].includes(key) ? 0 : 1) || value > max)) bad(`invalid ${key}`);
  }
  if (method === 'waitms' && params.ms === undefined) bad('milliseconds required');
  if (params.activate !== undefined && (method !== 'use' || typeof params.activate !== 'boolean')) bad('activate is a boolean option for use only');
  if (params.extension !== undefined && (method !== 'connect' || typeof params.extension !== 'boolean' || params.port !== undefined)) bad('connect --extension cannot take a CDP port');
  if (['req', 'res'].includes(method) && params.n === undefined) bad('request number required');
  if (method === 'overlay' && typeof params.enabled !== 'boolean') bad('overlay requires on or off');
  if (params.browser && !params.daemon) bad('--browser requires kill --daemon');
  if (method === 'kill' && params.session && params.daemon) bad('--session and --daemon cannot be combined');
  if (['goto', 'new'].includes(method) && params.url) {
    let url;
    try { url = new URL(params.url); } catch { bad('a complete URL is required'); }
    if (!['http:', 'https:', 'about:', 'file:', 'data:'].includes(url.protocol)) bad('unsupported URL protocol');
  }
}
