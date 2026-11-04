// The ios-environment skill is what the agent believes about this shell, so
// what it lists as available has to exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMMANDS } from '../runtime/shell.mjs';

const text = fs.readFileSync(new URL('../skills/ios-environment/SKILL.md', import.meta.url), 'utf8');

test('has the frontmatter the skill catalog needs', () => {
  const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.match(frontmatter, /^name: ios-environment$/m);
  // tool-skill caps catalog descriptions at 500 characters.
  assert.ok(/^description: (.+)$/m.exec(frontmatter)[1].length <= 500);
});

test('the catalog description sends plugin work here', () => {
  // The skill only loads when its description matches the task at hand.
  assert.match(/^description: (.+)$/m.exec(text)[1], /\bplugin\b/);
});

test('every command listed as existing exists', () => {
  const section = /## Commands that exist\n([\s\S]*?)\n## /.exec(text)[1];
  const listed = [...section.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split(' '));
  assert.ok(listed.length > 80);
  // Shell builtins are not commands of the world.
  const builtin = new Set(['type', 'command']);
  assert.deepEqual(listed.filter((name) => !COMMANDS.has(name) && !builtin.has(name)), []);
});
