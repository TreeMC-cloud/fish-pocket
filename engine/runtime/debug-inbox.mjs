// Debug builds only: run scripts dropped into <data>/debug inside the live
// engine, so behaviour that only exists on iOS (paths, fds, workers) can be
// probed without rebuilding. `x.mjs` exports a default (async) function; its
// result or error lands in `x.mjs.out`.
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';

export function startDebugInbox(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const busy = new Set();
  setInterval(async () => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!name.endsWith('.mjs') || busy.has(file) || fs.existsSync(`${file}.out`)) continue;
      busy.add(file);
      let text;
      try {
        const module = await import(`${pathToFileURL(file).href}?${Date.now()}`);
        text = inspect(await module.default(), { depth: 6, maxStringLength: 20000 });
      } catch (error) {
        text = `ERROR ${error?.stack ?? error}`;
      }
      fs.writeFileSync(`${file}.out`, `${text}\n`);
      busy.delete(file);
    }
  }, 500).unref();
}
