import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const targetDir = join(dshHome, '.agent-presets', 'yolo');
const srcDir = join(__dirname, 'presets', 'yolo');

try {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const files = ['preset.yml', 'agent.cordis.yml'];
  for (const file of files) {
    const src = join(srcDir, file);
    const dest = join(targetDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  console.log(`[dsh-plugin-yolo] Synced YOLO preset to ${targetDir}`);
} catch (err) {
  console.warn(`[dsh-plugin-yolo] Could not sync preset to ${targetDir}: ${err.message}`);
}
