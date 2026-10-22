import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/cli/repl.js';
import { resolveScope } from '../../src/cli/commands.js';
import { parseArgv } from '../../src/cli/parser.js';

test('tokenizes quoted REPL input', () => {
  assert.deepEqual(tokenize('fill "input[name=q]" "hello world" --json'), ['fill', 'input[name=q]', 'hello world', '--json']);
});

test('REPL defaults never become kill targets; per-command overrides do not persist', () => {
  const defaults = { session: 'A', task: 'B' };
  const scope = (args) => resolveScope(parseArgv(args), undefined, defaults);
  assert.deepEqual(scope(['status']), { sessionId: 'A', taskId: 'B' });
  assert.deepEqual(scope(['status', '--session', 'C', '--task', 'D']), { sessionId: 'C', taskId: 'D' });
  assert.deepEqual(scope(['status']), { sessionId: 'A', taskId: 'B' });
  assert.deepEqual(scope(['kill', '--session', 'C']), { sessionId: 'A', taskId: 'B' });
  assert.deepEqual(scope(['kill', '--session']), { sessionId: 'A', taskId: 'B' });
});

test('preserves empty strings and literal backslashes inside single quotes', () => {
  assert.deepEqual(tokenize("fill input ''"), ['fill', 'input', '']);
  assert.deepEqual(tokenize("eval 'String.raw`a\\b`'"), ['eval', 'String.raw`a\\b`']);
  assert.throws(() => tokenize('fill input "oops'), /unterminated quote/);
});
