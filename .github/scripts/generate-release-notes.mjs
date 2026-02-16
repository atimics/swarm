#!/usr/bin/env node

import { execSync } from 'node:child_process';

function run(command, fallback = '') {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function getReleaseTag() {
  const provided = process.env.RELEASE_TAG?.trim();
  if (provided) return provided;
  const latest = run("git describe --tags --abbrev=0 --match 'v*'");
  if (!latest) {
    throw new Error('Unable to resolve release tag. Set RELEASE_TAG or create a v* tag.');
  }
  return latest;
}

function getPreviousTag(currentTag) {
  const tags = run("git tag --list 'v*' --sort=-v:refname")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const index = tags.indexOf(currentTag);
  if (index === -1) return null;
  return tags[index + 1] ?? null;
}

function classifyType(subject) {
  const match = /^([a-z]+)(\([^)]+\))?:\s/i.exec(subject);
  return match ? match[1].toLowerCase() : 'other';
}

function summarizeAreas(files) {
  const areaCounts = new Map();
  for (const file of files) {
    const packageMatch = /^packages\/([^/]+)\//.exec(file);
    const area = packageMatch ? `packages/${packageMatch[1]}` : file.split('/')[0] || 'root';
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }

  return [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([area, count]) => `- ${area}: ${count} file(s)`)
    .join('\n');
}

function buildDeterministicNotes({
  releaseTag,
  previousTag,
  range,
  stats,
  commits,
  files,
}) {
  const typeBuckets = {
    feat: [],
    fix: [],
    refactor: [],
    perf: [],
    test: [],
    docs: [],
    chore: [],
    other: [],
  };

  for (const commit of commits) {
    const type = classifyType(commit.subject);
    (typeBuckets[type] ?? typeBuckets.other).push(commit);
  }

  const important = [...typeBuckets.feat, ...typeBuckets.fix, ...typeBuckets.refactor]
    .slice(0, 12)
    .map((c) => `- ${c.subject} (${c.sha})`)
    .join('\n');

  const allCommits = commits
    .slice(0, 60)
    .map((c) => `- ${c.subject} (${c.sha})`)
    .join('\n');

  const truncatedNotice = commits.length > 60
    ? `\n- ...and ${commits.length - 60} more commit(s)`
    : '';

  const baselineLine = previousTag
    ? `Changes since ${previousTag} (${range})`
    : `Changes included in ${releaseTag}`;

  const areaSummary = summarizeAreas(files) || '- No file changes detected';
  const commitSummary = [
    `- Total commits: ${commits.length}`,
    `- Features: ${typeBuckets.feat.length}`,
    `- Fixes: ${typeBuckets.fix.length}`,
    `- Refactors: ${typeBuckets.refactor.length}`,
    `- Tests: ${typeBuckets.test.length}`,
    `- Docs/Chores: ${typeBuckets.docs.length + typeBuckets.chore.length}`,
  ].join('\n');

  return `# ${releaseTag}\n\n${baselineLine}\n\n## Highlights\n${important || '- Internal maintenance and reliability improvements'}\n\n## Scope\n${stats ? `- ${stats}` : '- Scope summary unavailable'}\n${commitSummary}\n\n## Primary Areas\n${areaSummary}\n\n## Commit List\n${allCommits || '- No commits in range'}${truncatedNotice}\n`;
}

async function maybeEnhanceWithAI(markdown, context) {
  const enabled = (process.env.ENABLE_AI_RELEASE_NOTES ?? 'true').toLowerCase() === 'true';
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!enabled || !apiKey) return markdown;

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const prompt = [
    'Rewrite these release notes into concise, user-facing notes.',
    'Constraints:',
    '- Do not invent features or fixes.',
    '- Keep all factual details grounded in the provided content.',
    '- Keep sections: Overview, Key Changes, Reliability/Infra, Notes.',
    '- Keep markdown format.',
    '',
    `Context: ${JSON.stringify(context)}`,
    '',
    'Source notes:',
    markdown,
  ].join('\n');

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a release engineering assistant. Produce accurate release notes only from input facts.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return markdown;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    return content || markdown;
  } catch {
    return markdown;
  }
}

async function main() {
  const releaseTag = getReleaseTag();
  const tagCommit = run(`git rev-list -n 1 ${releaseTag}`);
  if (!tagCommit) {
    throw new Error(`Tag not found or has no commit: ${releaseTag}`);
  }

  const previousTag = getPreviousTag(releaseTag);
  const range = previousTag ? `${previousTag}..${releaseTag}` : releaseTag;

  const stats = run(`git diff --shortstat ${range}`);
  const commitLines = run(`git log --no-merges --pretty=format:%h%x09%s%x09%an ${range}`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const commits = commitLines.map((line) => {
    const [sha, subject, author] = line.split('\t');
    return { sha, subject: subject || '', author: author || '' };
  });

  const files = run(`git diff --name-only ${range}`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const deterministic = buildDeterministicNotes({
    releaseTag,
    previousTag,
    range,
    stats,
    commits,
    files,
  });

  const notes = await maybeEnhanceWithAI(deterministic, {
    releaseTag,
    previousTag,
    range,
    commitCount: commits.length,
    changedFileCount: files.length,
    repository: process.env.GITHUB_REPOSITORY || '',
  });

  process.stdout.write(notes);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
