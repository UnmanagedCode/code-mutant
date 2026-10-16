// The runtime never needs a dependency.
//
// code-mutant is installed by `git clone` alone: no install step ever runs, so
// `node_modules/` never exists in a user's copy. `vitest` is a devDependency for
// this repo's own suite only. A runtime import of anything that is not a `node:`
// builtin or a relative path would work in a developer checkout and fail in every
// real install -- so the module graph is walked by Node's own resolver rather than
// by a regex over the source, which a canary template string carrying an
// `import ... from 'vitest'` line would fool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function libModules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return libModules(abs);
    return entry.name.endsWith('.mjs') ? [abs] : [];
  });
}

test('mutate.mjs and every lib module import only node: builtins and relative paths', () => {
  const entries = [path.join(REPO, 'mutate.mjs'), ...libModules(path.join(REPO, 'lib'))];
  const repoUrl = pathToFileURL(`${REPO}/`).href;
  // Runs in a child so the hook sees a cold module graph. Every entry script
  // guards its main on argv[1], so importing one here runs nothing.
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({
      resolve(specifier, context, next) {
        const parent = context.parentURL ?? '';
        // Module parents only: the driver's own imports (parent "[eval1]") name
        // the entries by absolute URL and are not part of the graph under test.
        if (parent.startsWith(${JSON.stringify(repoUrl)}) && parent.endsWith('.mjs')
          && !parent.includes('/node_modules/')) {
          seen.push({ specifier, parent: parent.slice(${repoUrl.length}) });
        }
        return next(specifier, context);
      },
    });
    for (const file of ${JSON.stringify(entries.map((f) => pathToFileURL(f).href))}) await import(file);
    process.stdout.write(JSON.stringify(seen));
  `;
  const seen = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' },
  }));

  assert.ok(seen.length > 20, `the walk saw the module graph (${seen.length} imports)`);
  const foreign = seen.filter(({ specifier }) => !specifier.startsWith('node:') && !specifier.startsWith('.'));
  assert.deepEqual(foreign, [], 'a runtime import outside node: builtins and relative paths');
});
