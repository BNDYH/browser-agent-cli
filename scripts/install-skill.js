import { installSkill } from '../src/cli/commands.js';

process.stdout.write(`${JSON.stringify(installSkill(), null, 2)}\n`);
