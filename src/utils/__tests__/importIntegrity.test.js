#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '../..');

let passed = 0, failed = 0;
const failures = [];

function pass(msg) { passed++; process.stdout.write(`  ✓ ${msg}\n`); }
function fail(msg, details = []) {
  failed++;
  failures.push({ msg, details });
  process.stdout.write(`  ✗ ${msg}\n`);
  details.slice(0, 5).forEach(d => process.stdout.write(`      ${d}\n`));
  if (details.length > 5) process.stdout.write(`      ... and ${details.length - 5} more\n`);
}

function getAllSourceFiles() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) results.push(full);
    }
  }
  walk(SRC);
  return results;
}

function relativeImportExists(fromFile, importPath) {
  const resolved = path.resolve(path.dirname(fromFile), importPath);
  return ['.ts','.tsx','.js','.jsx','/index.ts','/index.tsx','/index.js']
    .some(ext => fs.existsSync(resolved + ext)) || fs.existsSync(resolved);
}

const allFiles = getAllSourceFiles();
const fileContents = new Map();
for (const f of allFiles) fileContents.set(f, fs.readFileSync(f, 'utf8'));

console.log(`\nImport Integrity — scanning ${allFiles.length} source files\n`);

// TEST 1: Broken relative import paths
console.log('TEST 1: Broken relative import paths');
{
  const broken = [];
  for (const [filePath, content] of fileContents) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      const m = line.match(/from\s+'(\.[^']+)'/);
      if (!m) continue;
      if (!relativeImportExists(filePath, m[1])) {
        broken.push(`${filePath.replace(SRC+'/', '')}:${i+1} → '${m[1]}'`);
      }
    }
  }
  if (broken.length === 0) pass('All relative imports resolve to existing files');
  else fail(`${broken.length} broken relative import path(s)`, broken);
}

// TEST 2: Duplicate React imports
console.log('\nTEST 2: Duplicate React imports');
{
  const dupes = [];
  for (const [filePath, content] of fileContents) {
    const n = (content.match(/^import React.*from 'react'/gm) || []).length;
    if (n > 1) dupes.push(`${filePath.replace(SRC+'/', '')} (${n}x)`);
  }
  if (dupes.length === 0) pass('No duplicate React imports');
  else fail(`${dupes.length} file(s) with duplicate React imports`, dupes);
}

// TEST 3: Missing Pressable import
console.log('\nTEST 3: Missing Pressable import from react-native');
{
  const missing = [];
  for (const [filePath, content] of fileContents) {
    if (!filePath.endsWith('.tsx')) continue;
    if (/<Pressable\b/.test(content) && !/import[^'"]*\bPressable\b[^'"]*from\s+'react-native'/.test(content))
      missing.push(filePath.replace(SRC+'/', ''));
  }
  if (missing.length === 0) pass('Pressable imported wherever used');
  else fail(`${missing.length} file(s) use <Pressable> without importing it`, missing);
}

// TEST 4: Missing React hook imports
console.log('\nTEST 4: Missing React hook imports');
{
  const hooks = ['useState','useEffect','useRef','useCallback','useMemo','useContext'];
  const missing = [];
  for (const [filePath, content] of fileContents) {
    for (const hook of hooks) {
      if (new RegExp(`\\b${hook}\\s*\\(`).test(content) &&
          !new RegExp(`import[^'"]*\\b${hook}\\b[^'"]*from\\s+'react'`).test(content))
        missing.push(`${filePath.replace(SRC+'/', '')}: missing '${hook}'`);
    }
  }
  if (missing.length === 0) pass('All React hooks imported where used');
  else fail(`${missing.length} missing React hook import(s)`, missing);
}

// TEST 5: Corrupted import lines
console.log('\nTEST 5: Corrupted import lines');
{
  const corrupted = [];
  for (const [filePath, content] of fileContents) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.match(/\bimport\b/g) || []).length > 1)
        corrupted.push(`${filePath.replace(SRC+'/', '')}:${i+1} → ${line.trim().slice(0,80)}`);
      if (line.includes('─') && /^\s*import\b/.test(line))
        corrupted.push(`${filePath.replace(SRC+'/', '')}:${i+1} → box-drawing in import`);
    }
  }
  if (corrupted.length === 0) pass('No corrupted import lines detected');
  else fail(`${corrupted.length} corrupted import line(s)`, corrupted);
}

// TEST 6: Duplicate imports from same module
console.log('\nTEST 6: Duplicate imports from same module');
{
  const dupes = [];
  for (const [filePath, content] of fileContents) {
    const counts = {};
    for (const line of content.split('\n')) {
      if (line.trimStart().startsWith('//')) continue;
      const m = line.match(/^import\s+.*from\s+'([^']+)'/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    for (const [mod, count] of Object.entries(counts))
      if (count > 1) dupes.push(`${filePath.replace(SRC+'/', '')}: '${mod}' (${count}x)`);
  }
  if (dupes.length === 0) pass('No duplicate module imports');
  else fail(`${dupes.length} duplicate module import(s)`, dupes);
}

// TEST 7: Common undefined RN symbols in TSX
console.log('\nTEST 7: Common undefined RN symbols in TSX');
{
  const REQUIRED = { TouchableOpacity:'react-native', FlatList:'react-native',
    ActivityIndicator:'react-native', Modal:'react-native', Alert:'react-native' };
  const issues = [];
  for (const [filePath, content] of fileContents) {
    if (!filePath.endsWith('.tsx')) continue;
    for (const [symbol] of Object.entries(REQUIRED)) {
      if (new RegExp(`<${symbol}\\b|\\b${symbol}\\.`).test(content) &&
          !new RegExp(`import[^'"]*\\b${symbol}\\b`).test(content))
        issues.push(`${filePath.replace(SRC+'/', '')}: '${symbol}' used but not imported`);
    }
  }
  if (issues.length === 0) pass('All common RN symbols imported where used');
  else fail(`${issues.length} missing RN symbol import(s)`, issues);
}

// SUMMARY
const total = passed + failed;
console.log('\n' + '─'.repeat(60));
if (failed === 0) {
  console.log(`  ${passed} passed, 0 failed`);
  console.log('\n  ✓ ALL IMPORT INTEGRITY CHECKS PASSED\n');
} else {
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('\n  FAILURES:');
  failures.forEach(({ msg, details }) => {
    console.log(`    ✗ ${msg}`);
    details.slice(0, 3).forEach(d => console.log(`        ${d}`));
  });
  console.log('');
  process.exit(1);
}
