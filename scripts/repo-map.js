#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_TOP = 15;
const DEFAULT_MIN_LINES = 80;
const DEFAULT_JSON_PATH = '.ai/repo-map.json';
const DEFAULT_CONTEXT_PATH = '.ai/context-pack.md';

function parseArgs(argv) {
  const args = {
    top: DEFAULT_TOP,
    minLines: DEFAULT_MIN_LINES,
    json: false,
    jsonPath: DEFAULT_JSON_PATH,
    context: false,
    contextPath: DEFAULT_CONTEXT_PATH,
  };

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
      continue;
    }
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--json-path' && argv[i + 1]) {
      args.jsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--context') {
      args.context = true;
      continue;
    }
    if (token === '--context-path' && argv[i + 1]) {
      args.contextPath = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

function isIgnoredPath(rel) {
  return (
    rel.includes('/node_modules/')
    || rel.includes('/dist/')
    || rel.includes('/coverage/')
    || rel.includes('/.git/')
    || rel.includes('/tests/')
    || rel.endsWith('.test.ts')
    || rel.endsWith('.spec.ts')
    || rel.endsWith('.d.ts')
  );
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git') || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== '.ts') {
      continue;
    }

    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    if (isIgnoredPath(`/${rel}`)) {
      continue;
    }

    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n').length;
    const bytes = statSync(abs).size;
    const importTargets = extractLocalImports(text, dirname(abs));

    out.push({ abs, rel, lines, bytes, importTargets });
  }
}

function extractLocalImports(text, importerDir) {
  const imports = new Set();
  const regex = /(?:import|export)\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) {
      continue;
    }
    const resolved = resolveImport(importerDir, spec);
    if (resolved) {
      imports.add(resolved);
    }
  }

  return [...imports];
}

function resolveImport(importerDir, specifier) {
  const base = resolve(importerDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    join(base, 'index.ts'),
  ];

  for (const abs of candidates) {
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        const rel = relative(ROOT, normalize(abs)).replaceAll('\\', '/');
        if (!isIgnoredPath(`/${rel}`)) {
          return rel;
        }
      }
    } catch {
      // ignore missing candidate
    }
  }

  return null;
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

function percentileRank(sortedValues, value) {
  if (sortedValues.length <= 1) {
    return 1;
  }
  const idx = sortedValues.findIndex((v) => v >= value);
  const position = idx === -1 ? sortedValues.length - 1 : idx;
  return position / (sortedValues.length - 1);
}

function stronglyConnectedComponents(nodes, adjacency) {
  let idx = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const components = [];

  function visit(node) {
    indices.set(node, idx);
    low.set(node, idx);
    idx += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        low.set(node, Math.min(low.get(node), low.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        low.set(node, Math.min(low.get(node), indices.get(neighbor)));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      visit(node);
    }
  }

  return components;
}

function computeAnalysis(files) {
  const byRel = new Map(files.map((file) => [file.rel, file]));
  const adjacency = new Map(files.map((file) => [file.rel, []]));
  const reverse = new Map(files.map((file) => [file.rel, []]));

  for (const file of files) {
    const edges = file.importTargets.filter((target) => byRel.has(target));
    adjacency.set(file.rel, edges);
    for (const edge of edges) {
      reverse.get(edge).push(file.rel);
    }
  }

  const linesSorted = [...files.map((f) => f.lines)].sort((a, b) => a - b);
  const fanInSorted = [...files.map((f) => reverse.get(f.rel).length)].sort((a, b) => a - b);
  const fanOutSorted = [...files.map((f) => adjacency.get(f.rel).length)].sort((a, b) => a - b);

  const scoredFiles = files.map((file) => {
    const fanIn = reverse.get(file.rel).length;
    const fanOut = adjacency.get(file.rel).length;
    const locRank = percentileRank(linesSorted, file.lines);
    const fanInRank = percentileRank(fanInSorted, fanIn);
    const fanOutRank = percentileRank(fanOutSorted, fanOut);
    const riskScore = Number((0.6 * locRank + 0.25 * fanInRank + 0.15 * fanOutRank).toFixed(3));

    return {
      ...file,
      bucket: bucketKey(file.rel),
      fanIn,
      fanOut,
      riskScore,
    };
  });

  const components = stronglyConnectedComponents(files.map((f) => f.rel), adjacency);
  const dependencyCycles = components
    .filter((component) => component.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((component) => component.sort());

  const buckets = new Map();
  for (const file of scoredFiles) {
    const current = buckets.get(file.bucket) ?? { files: 0, lines: 0, riskSum: 0 };
    current.files += 1;
    current.lines += file.lines;
    current.riskSum += file.riskScore;
    buckets.set(file.bucket, current);
  }

  return {
    scoredFiles,
    buckets: [...buckets.entries()]
      .map(([bucket, value]) => ({
        bucket,
        files: value.files,
        lines: value.lines,
        avgRisk: Number((value.riskSum / value.files).toFixed(3)),
      }))
      .sort((a, b) => b.lines - a.lines),
    dependencyCycles,
  };
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function formatRow(index, file) {
  const rank = String(index + 1).padStart(2, '0');
  const lines = String(file.lines).padStart(4, ' ');
  const fan = `${String(file.fanIn).padStart(3, ' ')}/${String(file.fanOut).padStart(3, ' ')}`;
  const risk = file.riskScore.toFixed(3);
  return `${rank}. ${lines} lines  fan(in/out)=${fan}  risk=${risk}  ${file.rel}`;
}

function buildContextPack(analysis, topN) {
  const topRisk = [...analysis.scoredFiles]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, topN);

  const bucketLines = analysis.buckets
    .slice(0, 10)
    .map((b) => `- ${b.bucket}: ${b.files} files, ${b.lines} LOC, avg risk ${b.avgRisk}`)
    .join('\n');

  const riskLines = topRisk
    .map((f, i) => `${i + 1}. ${f.rel} (LOC ${f.lines}, fan-in ${f.fanIn}, fan-out ${f.fanOut}, risk ${f.riskScore})`)
    .join('\n');

  const cycleLines = analysis.dependencyCycles.length === 0
    ? '- none detected'
    : analysis.dependencyCycles.slice(0, 5).map((cycle) => `- ${cycle.join(' -> ')}`).join('\n');

  return [
    '# AI Context Pack',
    '',
    'This file is generated by `scripts/repo-map.js --context --json`.',
    '',
    '## Highest-risk files to edit carefully',
    riskLines,
    '',
    '## Largest implementation buckets',
    bucketLines,
    '',
    '## Dependency cycles (local imports)',
    cycleLines,
    '',
    '## Recommended plan for AI edits',
    '1. Change exactly one high-risk file per PR unless you are extracting shared helpers.',
    '2. If touching a high fan-in file, add or run targeted tests first.',
    '3. Prefer helper extraction over appending more logic to files above 600 LOC.',
  ].join('\n');
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = [];
  walk(ROOT, files);

  const analysis = computeAnalysis(files);
  const totalFiles = files.length;
  const totalLines = files.reduce((acc, f) => acc + f.lines, 0);
  const totalEdges = analysis.scoredFiles.reduce((acc, f) => acc + f.fanOut, 0);

  console.log('AI Fund repo intelligence map');
  console.log(`TypeScript implementation files: ${totalFiles}`);
  console.log(`Total implementation lines: ${totalLines}`);
  console.log(`Local dependency edges: ${totalEdges}`);

  printSection(`Top ${args.top} files by AI risk score`);
  [...analysis.scoredFiles]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, args.top)
    .forEach((file, idx) => {
      console.log(formatRow(idx, file));
    });

  printSection(`Buckets with files >= ${args.minLines} lines`);
  analysis.buckets
    .filter((b) => b.lines / b.files >= args.minLines || b.lines >= args.minLines)
    .forEach((bucket) => {
      console.log(`- ${bucket.bucket}: ${bucket.files} files / ${bucket.lines} lines / avg risk ${bucket.avgRisk}`);
    });

  printSection('Dependency cycle summary');
  if (analysis.dependencyCycles.length === 0) {
    console.log('No local import cycles detected.');
  } else {
    console.log(`Detected ${analysis.dependencyCycles.length} local import cycle(s).`);
    analysis.dependencyCycles.slice(0, 5).forEach((cycle, i) => {
      console.log(`${i + 1}. ${cycle.join(' -> ')}`);
    });
  }

  printSection('Suggested AI execution strategy');
  console.log('1) Run `npm run repo:map:json` and load `.ai/context-pack.md` into your agent context.');
  console.log('2) Choose smallest target slice: one connector or one lib subsystem.');
  console.log('3) For risk score > 0.75 files, prefer extraction-first refactors.');

  if (args.json || args.context) {
    const payload = {
      generatedAt: new Date().toISOString(),
      root: ROOT,
      summary: {
        files: totalFiles,
        lines: totalLines,
        dependencyEdges: totalEdges,
        dependencyCycles: analysis.dependencyCycles.length,
      },
      topRisk: [...analysis.scoredFiles]
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, args.top)
        .map((file) => ({
          path: file.rel,
          bucket: file.bucket,
          lines: file.lines,
          fanIn: file.fanIn,
          fanOut: file.fanOut,
          riskScore: file.riskScore,
        })),
      buckets: analysis.buckets,
      dependencyCycles: analysis.dependencyCycles,
    };

    if (args.json) {
      ensureDir(args.jsonPath);
      writeFileSync(args.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`\nWrote machine-readable report: ${args.jsonPath}`);
    }

    if (args.context) {
      ensureDir(args.contextPath);
      const contextPack = buildContextPack(analysis, args.top);
      writeFileSync(args.contextPath, `${contextPack}\n`, 'utf8');
      console.log(`Wrote AI context pack: ${args.contextPath}`);
    }
  }
}

main();
