// The app runs in Android's WebView, which on older phones can be as old as
// Chrome 83 (the Android 11 emulator ships 83.0.4103). One newer piece of
// syntax stops every module from loading (1.6.0 shipped `||=` until the
// emulator caught it), so the app's own code is checked for features newer
// than Chrome 83.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/src/main/assets/www/js');

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

const NEWER = [
  [/\|\|=|&&=|\?\?=/, 'logical assignment (Chrome 85)'],
  [/\.at\(/, 'Array/String .at() (Chrome 92)'],
  [/\.replaceAll\(/, 'String.replaceAll (Chrome 85)'],
  [/\.findLast(Index)?\(/, 'findLast (Chrome 97)'],
  [/structuredClone\(/, 'structuredClone (Chrome 98)'],
  [/Object\.hasOwn\(/, 'Object.hasOwn (Chrome 93)'],
  [/\.toSorted\(|\.toReversed\(|\.with\(/, 'change-array-by-copy (Chrome 110)'],
  [/\bawait\s+import\(|^await /m, 'top-level await in a module (Chrome 89)'],
];

test('the app code uses nothing newer than Chrome 83', () => {
  const problems = [];
  for (const f of files(ROOT)) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const [re, what] of NEWER) if (re.test(code)) problems.push(`${path.relative(ROOT, f)}:${i + 1} ${what}`);
    });
  }
  assert.deepEqual(problems, []);
});
