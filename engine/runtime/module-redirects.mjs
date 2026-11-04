// Native-addon entry points that cannot load on iOS, redirected to JavaScript
// stand-ins in shims/ at module resolution, so engine files stay untouched.
import { registerHooks } from 'node:module';

export const REDIRECTS = {
  '@deepseek-ai/node-addon-system/flock': new URL('../shims/flock.mjs', import.meta.url).href,
  '@vscode/ripgrep': new URL('../shims/ripgrep.mjs', import.meta.url).href,
  sharp: new URL('../shims/sharp.mjs', import.meta.url).href,
};

let installed = false;
export function installModuleRedirects() {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = REDIRECTS[specifier];
      return url ? { url, format: 'module', shortCircuit: true } : nextResolve(specifier, context);
    },
  });
}
