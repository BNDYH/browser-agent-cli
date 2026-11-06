import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv, toRpcCommand } from '../../src/cli/parser.js';
import { validateCommand } from '../../src/validation.js';

test('parses global options and action arguments', () => {
  const parsed = parseArgv(['fill', 'input[name=q]', 'hello world', '--json', '--timeout', '2500', '--session', 's1']);
  assert.equal(parsed.options.json, true);
  assert.deepEqual(toRpcCommand(parsed), ['fill', { selector: 'input[name=q]', text: 'hello world', timeout: 2500, delay: undefined }]);
});

test('activation is explicit and only accepted for use', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['use', 'target', '--activate'])), ['use', { id: 'target', activate: true }]);
  assert.equal(toRpcCommand(parseArgv(['use', 'target']))[1].activate, undefined);
  assert.throws(() => toRpcCommand(parseArgv(['new', '--activate'])));
  assert.throws(() => validateCommand('use', { id: 'target', activate: 'yes' }));
  assert.throws(() => validateCommand('title', { activate: true }));
  assert.throws(() => parseArgv(['repl', '--session', '--json']));
});

test('dispatches overloaded ls command by first argument', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['ls', 'input'])), ['ls.elements', { selector: 'input' }]);
  assert.deepEqual(toRpcCommand(parseArgv(['ls', 'get', 'token'])), ['ls.get', { key: 'token', value: undefined }]);
});

test('kill --session without value means current session', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['kill', '--session'])), ['kill', { daemon: false, browser: false, session: true }]);
  assert.deepEqual(toRpcCommand(parseArgv(['kill', '--session', 'other'])), ['kill', { daemon: false, browser: false, session: 'other' }]);
});

test('leaves default port resolution to daemon config', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['launch'])), ['launch', { port: undefined, profile: undefined }]);
  assert.deepEqual(toRpcCommand(parseArgv(['connect', '9333'])), ['connect', { port: 9333 }]);
});

test('connection preview options and explicit toggles', () => {
  assert.deepEqual(toRpcCommand(parseArgv(['connect', '--no-companion'])), ['connect', { port: undefined, companion: false }]);
  assert.equal(toRpcCommand(parseArgv(['launch', '--no-companion']))[1].companion, false);
  assert.deepEqual(toRpcCommand(parseArgv(['companion', 'off'])), ['companion', { enabled: false }]);
  assert.deepEqual(toRpcCommand(parseArgv(['companion'])), ['companion', {}]);
  assert.throws(() => toRpcCommand(parseArgv(['companion', 'invalid'])));
  assert.throws(() => toRpcCommand(parseArgv(['title', '--no-companion'])));
});

test('rejects malformed and destructive ambiguous requests before starting daemon', () => {
  for (const args of [ ['connect', 'https://remote.test'], ['launch', '--port', '0'], ['waitms', '-1'],
    ['wait', 'input', '--timeout', 'NaN'], ['ck', 'set', 'key'], ['ck', 'unknown'],
    ['overlay', 'oops'], ['kill', '--browser'], ['fill', 'input', 'x', '--daemon'], ['ls', 'input', 'extra'] ]) {
    assert.throws(() => toRpcCommand(parseArgv(args)), JSON.stringify(args));
  }
  assert.equal(toRpcCommand(parseArgv(['fill', 'input', '']))[1].text, '');
});
