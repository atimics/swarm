import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.pnpm',
  '.git',
  'cdk.out',
  'dist',
  'build',
  '.turbo',
]);

function listFilesRecursive(rootDir: string, currentDir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      listFilesRecursive(rootDir, path.join(currentDir, entry.name), acc);
      continue;
    }

    if (entry.isFile()) {
      const absPath = path.join(currentDir, entry.name);
      acc.push(path.relative(rootDir, absPath));
    }
  }
}

function addFileToHash(hash: crypto.Hash, absPath: string, relKey: string): void {
  hash.update(relKey);
  hash.update('\0');
  try {
    hash.update(fs.readFileSync(absPath));
  } catch {
    hash.update(`__MISSING__:${relKey}`);
  }
  hash.update('\n');
}

/**
 * Compute a stable asset hash for the dependency layer.
 *
 * pnpm installs create symlinks whose absolute paths can vary per runner,
 * causing the CDK asset hash to change even when dependency inputs are identical.
 * That can trigger Lambda LayerVersion replacement, which fails if other stacks
 * import the layer via CloudFormation exports.
 */
export function computeDependencyLayerAssetHash(layerRootDir: string): string {
  const hash = crypto.createHash('sha256');
  hash.update('swarm:dependency-layer-asset-hash:v1\n');

  // Prefer hashing lockfiles / manifests rather than node_modules contents.
  const repoRoot = path.resolve(layerRootDir, '../..');
  addFileToHash(hash, path.join(repoRoot, 'pnpm-lock.yaml'), 'pnpm-lock.yaml');
  addFileToHash(hash, path.join(layerRootDir, 'package.json'), 'packages/layer/package.json');
  addFileToHash(
    hash,
    path.join(layerRootDir, 'nodejs', 'package-lock.json'),
    'packages/layer/nodejs/package-lock.json'
  );
  addFileToHash(hash, path.join(layerRootDir, 'nodejs', 'package.json'), 'packages/layer/nodejs/package.json');

  // Include shim sources (exclude node_modules and other volatile dirs).
  for (const shimDir of ['abort-controller-shim', 'node-fetch-shim']) {
    const absShimDir = path.join(layerRootDir, shimDir);
    if (!fs.existsSync(absShimDir) || !fs.statSync(absShimDir).isDirectory()) {
      addFileToHash(hash, absShimDir, `packages/layer/${shimDir}.__missing__`);
      continue;
    }

    const files: string[] = [];
    listFilesRecursive(absShimDir, absShimDir, files);
    files.sort();
    for (const relPath of files) {
      addFileToHash(hash, path.join(absShimDir, relPath), `packages/layer/${shimDir}/${relPath}`);
    }
  }

  return hash.digest('hex');
}
