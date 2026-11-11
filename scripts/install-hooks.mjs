// `npm install` (prepare): point git at .githooks so every commit runs
// check:fast. Skipped quietly outside a git checkout (a GitHub "Download ZIP",
// or no git installed), where `git config` would fail and take npm install,
// and so install.command / install.bat, down with it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
