import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit public assets only: never upload the repository or local server.
const root = dirname(fileURLToPath(import.meta.url));
const files = ['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'llms.txt', 'styles.css', 'hero-motion.css', 'tutorial.css', 'app.js', 'assets/logo.svg', 'assets/factory.webp', 'assets/factory-flow-loop.mp4', 'assets/sdlc-codex-og-v1.jpg'];
const output = await mkdtemp(join(tmpdir(), 'sdlc-codex-pages-'));
for (const file of files) {
  if (/\.(html|css|js|svg)$/.test(file)) {
    const content = await readFile(join(root, file), 'utf8');
    if (/r8_[A-Za-z0-9]{20,}/.test(content)) throw new Error(`Credential detected in ${file}`);
  }
  await mkdir(dirname(join(output, file)), { recursive: true });
  await copyFile(join(root, file), join(output, file));
}
console.log(output);
