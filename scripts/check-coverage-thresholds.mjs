#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LCOV_PATH = resolve(process.cwd(), 'coverage/lcov.info');

const thresholds = {
  lines: 40,
  functions: 40,
  branches: 40,
  statements: 40,
};

function pct(hit, found) {
  return found === 0 ? 100 : (hit / found) * 100;
}

function formatPercent(value) {
  return value.toFixed(2);
}

function parseLcov(content) {
  const metrics = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };

  let includeRecord = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('SF:')) {
      const file = line.slice(3);
      includeRecord = file.includes('/src/') && !file.includes('/dist/');
      continue;
    }

    if (!includeRecord) continue;

    if (line.startsWith('LF:')) {
      metrics.lines.found += Number(line.slice(3));
      continue;
    }

    if (line.startsWith('LH:')) {
      metrics.lines.hit += Number(line.slice(3));
      continue;
    }

    if (line.startsWith('FNF:')) {
      metrics.functions.found += Number(line.slice(4));
      continue;
    }

    if (line.startsWith('FNH:')) {
      metrics.functions.hit += Number(line.slice(4));
      continue;
    }

    if (line.startsWith('BRF:')) {
      metrics.branches.found += Number(line.slice(4));
      continue;
    }

    if (line.startsWith('BRH:')) {
      metrics.branches.hit += Number(line.slice(4));
    }
  }

  return metrics;
}

let lcov;
try {
  lcov = readFileSync(LCOV_PATH, 'utf8');
} catch (error) {
  console.error(`Coverage file missing: ${LCOV_PATH}`);
  process.exit(1);
}

const parsed = parseLcov(lcov);
const results = {
  lines: pct(parsed.lines.hit, parsed.lines.found),
  functions: pct(parsed.functions.hit, parsed.functions.found),
  branches: pct(parsed.branches.hit, parsed.branches.found),
  // LCOV does not expose statement totals independently; use line coverage as proxy.
  statements: pct(parsed.lines.hit, parsed.lines.found),
};

console.log('Coverage thresholds (src only):');
for (const [metric, threshold] of Object.entries(thresholds)) {
  const value = results[metric];
  console.log(`- ${metric}: ${formatPercent(value)}% (threshold ${threshold}%)`);
}

const failing = Object.entries(thresholds).filter(([metric, threshold]) => results[metric] < threshold);

if (failing.length > 0) {
  console.error('\nCoverage threshold check failed.');
  for (const [metric, threshold] of failing) {
    console.error(`- ${metric}: ${formatPercent(results[metric])}% < ${threshold}%`);
  }
  process.exit(1);
}

console.log('\nCoverage threshold check passed.');
