import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
const files = ['app.js', 'style.css', 'model.mjs', 'browser-demo.mjs', 'browser-office.mjs'];
await Promise.all(files.map((name) => copyFile(new URL(name, import.meta.url), new URL(name, dist))));
const zip = resolve(dirname(require.resolve('fflate')), '../esm/browser.js');
await copyFile(zip, new URL('fflate.mjs', dist));
await copyFile(resolve(dirname(zip), '../LICENSE'), new URL('fflate-LICENSE.txt', dist));

const index = await readFile(new URL('./index.html', import.meta.url), 'utf8');
await writeFile(new URL('index.html', dist), index
  .replace('<title>', '<meta name="board-digest-mode" content="browser-demo">\n  <title>')
  .replace('ต้นแบบในเครื่อง · ข้อมูลจำลอง', 'เดโมออนไลน์ · ข้อมูลแยกตามเบราว์เซอร์'));
