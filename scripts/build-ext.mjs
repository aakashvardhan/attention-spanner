// `npm run build:ext`: assets, the oxichrome build into rust/ext/.build, then
// the swap into rust/ext/dist/chromium. A script rather than a one-line npm
// command because npm runs scripts in cmd.exe on Windows, which has no
// `VAR=value cmd` prefix; spawning with `env` works on every OS.
import { spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, ['scripts/rust-assets.mjs']);
// --locked: the CLI builds from vendor/oxichrome/Cargo.lock, the same on every clone.
run('cargo', ['run', '-q', '--locked', '--manifest-path', '../../vendor/oxichrome/oxichrome-cli/Cargo.toml', '--', 'oxichrome', 'build', '--release'], {
  cwd: 'rust/ext',
  env: { ...process.env, OXICHROME_DIST: '.build' },
});
run(process.execPath, ['scripts/publish-ext.mjs']);
