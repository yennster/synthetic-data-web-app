// Postinstall: copy the three-usdz-loader WASM files into public/usdz-wasm/
// so the dev server (and build output) serves them at /usdz-wasm/*.
// The loader fetches them lazily the first time a USDZ is imported.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'three-usdz-loader', 'external');
const dst = path.join(root, 'public', 'usdz-wasm');

const FILES = [
  'emHdBindings.js',
  'emHdBindings.data',
  'emHdBindings.wasm',
  'emHdBindings.worker.js',
];

// Only run for source checkouts. When a consumer installs this package from
// npm, only `bin/` and `dist/` are present and the WASM is already in
// `dist/usdz-wasm/`, so there's nothing to do.
try {
  await fs.access(path.join(root, 'src'));
} catch {
  process.exit(0);
}

try {
  await fs.access(src);
} catch {
  // three-usdz-loader not installed yet (first-run npm install ordering)
  console.log('[setup-usdz-wasm] three-usdz-loader not installed yet, skipping');
  process.exit(0);
}

await fs.mkdir(dst, { recursive: true });
for (const f of FILES) {
  await fs.copyFile(path.join(src, f), path.join(dst, f));
}
console.log(`[setup-usdz-wasm] copied ${FILES.length} files → public/usdz-wasm/`);
