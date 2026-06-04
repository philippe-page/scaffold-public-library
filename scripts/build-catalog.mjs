import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = path.join(REPO_ROOT, 'library');
const CATALOG_PATH = path.join(REPO_ROOT, 'catalog.json');

const GITHUB_OWNER = 'philippe-page';
const GITHUB_REPO = 'scaffold-public-library';
const GITHUB_REF = 'main';
const GITHUB_API = 'https://api.github.com';

function formatCategoryLabel(category) {
  return category
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isManifest(v) {
  if (!isRecord(v)) return false;
  if (v.version !== 1) return false;
  if (typeof v.exportDate !== 'string') return false;
  if (typeof v.sourceName !== 'string') return false;
  if (typeof v.sourceIdentifier !== 'string') return false;
  if (typeof v.entityCount !== 'number') return false;
  if (typeof v.relationshipCount !== 'number') return false;
  if (typeof v.vectorCount !== 'number') return false;
  if (v.packageId !== undefined && typeof v.packageId !== 'string') return false;
  if (v.modelId !== undefined && typeof v.modelId !== 'string') return false;
  return true;
}

function isScaffoldPackage(v) {
  if (!isRecord(v)) return false;
  if (!isManifest(v.manifest)) return false;
  if (!isRecord(v.graph)) return false;
  const graph = v.graph;
  if (!Array.isArray(graph.entities) || !Array.isArray(graph.relationships)) return false;
  if (!isRecord(v.vectors)) return false;
  if (!Array.isArray(v.vectors.memories)) return false;
  return true;
}

function scaffoldPackageCounts(pkg) {
  return {
    entityCount: pkg.graph.entities.length,
    relationshipCount: pkg.graph.relationships.length,
    vectorCount: pkg.vectors.memories.length
  };
}

async function callGitHubApi(endpoint, accept = 'application/vnd.github.v3+json') {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to resolve file contributors');
  }

  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'scaffold-public-library-catalog-build'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} (${endpoint})`);
  }

  return response.json();
}

async function fetchOldestCommitForPath(filePath) {
  let page = 1;
  let oldest = null;

  while (true) {
    const endpoint = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(GITHUB_REF)}&per_page=100&page=${page}`;
    const commits = await callGitHubApi(endpoint);
    if (!Array.isArray(commits) || commits.length === 0) {
      break;
    }
    oldest = commits[commits.length - 1] ?? null;
    if (commits.length < 100) {
      break;
    }
    page += 1;
  }

  return oldest;
}

async function fetchCommitPullRequests(sha) {
  const endpoint = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${sha}/pulls`;
  return callGitHubApi(endpoint, 'application/vnd.github+json');
}

async function fetchFileContributor(filePath) {
  const commit = await fetchOldestCommitForPath(filePath);
  if (!commit) {
    return undefined;
  }

  const pullRequests = await fetchCommitPullRequests(commit.sha);
  const pullRequest = Array.isArray(pullRequests) ? pullRequests[0] : undefined;
  const githubUser = pullRequest?.user ?? commit.author;
  const login = githubUser?.login ?? commit.commit.author.name;
  const profileUrl = githubUser?.html_url ?? commit.html_url;

  const contributor = {
    login,
    name: githubUser?.login ?? commit.commit.author.name,
    avatarUrl: githubUser?.avatar_url ?? '',
    profileUrl,
    contributedAt:
      pullRequest?.merged_at ?? pullRequest?.created_at ?? commit.commit.author.date,
    commitUrl: commit.html_url
  };

  if (pullRequest?.html_url) {
    contributor.pullRequestUrl = pullRequest.html_url;
  }
  if (typeof pullRequest?.number === 'number') {
    contributor.pullRequestNumber = pullRequest.number;
  }

  return contributor;
}

async function listScaffoldFiles(dir, relativePrefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listScaffoldFiles(absolutePath, relativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.scaffold')) {
      files.push({
        absolutePath,
        path: `library/${relativePath}`
      });
    }
  }

  return files;
}

async function packageFromFile(file) {
  const text = await readFile(file.absolutePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${file.path}`);
  }

  if (!isScaffoldPackage(parsed)) {
    throw new Error(`Invalid scaffold package at ${file.path}`);
  }

  const category = file.path.split('/')[1];
  const filename = path.basename(file.path);
  const counts = scaffoldPackageCounts(parsed);
  const modelId = parsed.manifest.modelId?.trim() || undefined;
  const contributor = await fetchFileContributor(file.path);

  const pkg = {
    id: file.path,
    path: file.path,
    category,
    categoryLabel: formatCategoryLabel(category),
    filename,
    title: parsed.manifest.sourceName || filename,
    sourceName: parsed.manifest.sourceName,
    sourceIdentifier: parsed.manifest.sourceIdentifier,
    entityCount: counts.entityCount,
    relationshipCount: counts.relationshipCount,
    vectorCount: counts.vectorCount,
    exportDate: parsed.manifest.exportDate,
    packageId: parsed.manifest.packageId
  };

  if (modelId) {
    pkg.modelId = modelId;
  }
  if (contributor) {
    pkg.contributor = contributor;
  }

  return pkg;
}

async function buildCatalog() {
  const scaffoldFiles = await listScaffoldFiles(LIBRARY_ROOT);
  const packages = [];

  for (const file of scaffoldFiles) {
    packages.push(await packageFromFile(file));
  }

  packages.sort((a, b) => {
    const categoryCompare = a.categoryLabel.localeCompare(b.categoryLabel);
    if (categoryCompare !== 0) {
      return categoryCompare;
    }
    return a.title.localeCompare(b.title);
  });

  const categories = [...new Set(packages.map(pkg => pkg.category))];

  return { packages, categories };
}

const catalog = await buildCatalog();
await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Wrote ${catalog.packages.length} packages to catalog.json`);
