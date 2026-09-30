import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const staging = mkdtempSync(join(tmpdir(), 'ai-usage-overlay-v3-build-'));
const dist = join(process.cwd(), 'dist');

try {
  const result = spawnSync(process.execPath, [
    join(process.cwd(), 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    `--config.directories.output=${staging}`,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Electron Builder exited with ${result.status ?? 1}`);

  const installer = readdirSync(staging).find((name) => /^AIUsageOverlayV3-Setup-.*\.exe$/.test(name));
  if (!installer) throw new Error('Electron Builder did not produce an installer');

  mkdirSync(dist, { recursive: true });
  for (const name of [installer, `${installer}.blockmap`]) {
    copyFileSync(join(staging, name), join(dist, name));
  }
  console.log(`Installer: ${join(dist, installer)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
