// Applies already-resolved sites into a workspace.
//
// `git apply` appears here in its FORWARD direction only, to apply a patch site.
// Its inverse is never used to restore -- see the ban documented in snapshot.mjs.
// This module never removes a mutation; restore is the snapshot's job.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SiteError, SiteErrorCode } from './sites.mjs';

export function applyResolved(root, resolved) {
  for (const entry of resolved) {
    if (entry.kind === 'anchor') {
      const abs = path.resolve(root, entry.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, entry.content);
      continue;
    }

    try {
      execFileSync('git', ['apply', '-'], {
        cwd: root,
        input: entry.patch,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const detail = (err.stderr?.toString?.() ?? err.message ?? String(err)).trim();
      throw new SiteError(SiteErrorCode.PATCH_REJECTED, `git apply failed: ${detail}`);
    }
  }
}
