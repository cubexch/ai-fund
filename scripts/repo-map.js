#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_TOP = 15;
const DEFAULT_MIN_LINES = 80;

function parseArgs(argv) {
  const args = { top: DEFAULT_TOP, minLines: DEFAULT_MIN_LINES };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--top' && argv[i + 1]) {
      args.top = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--min-lines' && argv[i + 1]) {
      args.minLines = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    if (rel.includes('/tests/') || rel.endsWith('.test.ts')) {
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n').length;
    out.push({ rel, lines, bytes: statSync(abs).size });
  }
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function bucketKey(path) {
  const [top, second, third] = path.split('/');
  if (top === 'connectors' && second && third) {
    return `connectors/${second}/${third}`;
  }
  if (top === 'connectors' && second) {
    return `connectors/${second}`;
  }
  return top;
}

function main() {
  const { top, minLines } = parseArgs(process.argv.slice(2));
  const files = [];
  walk(ROOT, files);

  const totalFiles = files.length;
  const totalLines = files.reduce((acc, file) => acc + file.lines, 0);

  console.log('AI Fund repo map');
  console.log(`TypeScript implementation files: ${totalFiles}`);
  console.log(`Total implementation lines: ${totalLines}`);

  printSection(`Top ${top} largest .ts files (non-test)`);
  [...files]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, top)
    .forEach((file, idx) => {
      console.log(`${String(idx + 1).padStart(2, '0')}. ${String(file.lines).padStart(4, ' ')}  ${file.rel}`);
    });

  printSection(`Buckets with files >= ${minLines} lines`);
  const buckets = new Map();
  for (const file of files) {
    if (file.lines < minLines) {
      continue;
    }
    const key = bucketKey(file.rel);
    const current = buckets.get(key) ?? { files: 0, lines: 0 };
    current.files += 1;
    current.lines += file.lines;
    buckets.set(key, current);
  }

  [...buckets.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .forEach(([key, value]) => {
      console.log(`- ${key}: ${value.files} files / ${value.lines} lines`);
    });

  printSection('Suggested AI change order');
  console.log('1) Pick a single workspace (lib or one connector).');
  console.log('2) Prefer adding helper modules instead of extending biggest files.');
  console.log('3) Add tests adjacent to behavior you changed.');
}

main();
