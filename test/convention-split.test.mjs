// The conductor convention's inline/skill split. cc owns the marker grammar;
// this pins only what this plugin owes it: one nameless marker, the briefing
// rules inline, the prover procedure in the skill, no sentence in both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../conventions/demand-mutation-verified.md', import.meta.url), 'utf8');
const lines = text.split('\n');
const markers = lines.filter(l => l.startsWith('<!-- cc:skill'));
const at = lines.findIndex(l => l.startsWith('<!-- cc:skill'));
const inline = lines.slice(0, at).join('\n');
const skill = lines.slice(at + 1).join('\n');

const sentences = part => part.replace(/[*`#>-]/g, ' ').split(/(?<=[.!?:—])\s+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 25);

test('exactly one nameless skill marker with a description', () => {
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^<!-- cc:skill (?!:)\S.* -->$/);
});

test('inline part points at the skill and keeps the break-source ban', () => {
  assert.match(inline, /cc-conductor-code-mutant:demand-mutation-verified/);
  assert.match(inline, /Never brief the implementer to break source to watch a test fail/);
});

test('skill part carries the one-prover-per-round rule', () => {
  assert.match(skill, /inplace-locked/);
  assert.match(skill, /One per round/);
});

test('no sentence appears in both parts', () => {
  const skillSet = new Set(sentences(skill));
  assert.deepEqual(sentences(inline).filter(s => skillSet.has(s)), []);
});
