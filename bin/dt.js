#!/usr/bin/env node
import { execute, installSkill, printResult } from '../src/cli/commands.js';
import { HELP, startRepl } from '../src/cli/repl.js';
import { installationPlan, installNativeHost } from '../src/extension/install.js';
import { formatError } from '../src/errors.js';

const argv = process.argv.slice(2);
try {
  if (!argv.length || argv[0] === 'help' || argv.includes('--help')) printResult({ result: { ok: true, text: HELP }, json: argv.includes('--json') });
  else if (argv[0] === 'repl') await startRepl(argv.slice(1));
  else if (argv[0] === 'install-skill') printResult({ result: installSkill(), json: argv.includes('--json') });
  else if (argv[0] === 'extension') {
    const args = argv.slice(1).filter((arg) => arg !== '--json');
    if (args.length > 1 || args[0] && !['info', 'install'].includes(args[0])) throw new Error('usage: dt extension info|install [--json]');
    printResult({ result: args[0] === 'install' ? installNativeHost() : { ok: true, ...installationPlan() }, json: argv.includes('--json') });
  }
  else printResult(await execute(argv));
} catch (error) {
  const json = argv.includes('--json');
  process.stderr.write(formatError(error, json) + '\n');
  process.exitCode = 1;
}
