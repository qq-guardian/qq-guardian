import { relative, sep } from 'node:path';

const NAPCAT_RUNTIME_FILES = new Set([
  'index.mjs',
  'package.json',
  'plugin-icon.png',
  'plugin.json',
  'webui/app.js',
  'webui/index.html',
  'webui/release-view.js',
  'webui/user-security.js',
]);

/**
 * Release archives are built from directories that operators may also use for
 * local deployment. Keep the accepted paths explicit so an untracked `.env`,
 * backup, or other local artifact can never be packaged accidentally.
 */
const SNOWLUMA_RUNTIME_FILES = new Set([
  'index.mjs',
  'package.json',
  'plugin-icon.png',
  'webui/app.js',
  'webui/index.html',
  'webui/release-view.js',
  'webui/user-security.js',
]);

const SNOWLUMA_DEPLOYMENT_FILES = new Set([
  '.env.example',
  'Dockerfile',
  'README.md',
  'compose.yaml',
  '1panel/README.md',
  'baota/README.md',
  'native/guardian.env.example',
  'native/initialize-guardian-state.ps1',
  'native/qq-guardian.service',
  'native/start-bundled-guardian.ps1',
  'native/start-bundled-guardian.sh',
  'native/start-guardian.ps1',
  'native/start-guardian.sh',
]);

const PROJECT_SOURCE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.yaml',
  '.yml',
]);

function normalizedRelative(directory, absolutePath) {
  return relative(directory, absolutePath).split(sep).join('/');
}

export function isNapCatRuntimeReleaseFile(directory, absolutePath) {
  return NAPCAT_RUNTIME_FILES.has(normalizedRelative(directory, absolutePath));
}

export function isSnowLumaRuntimeReleaseFile(directory, absolutePath) {
  return SNOWLUMA_RUNTIME_FILES.has(normalizedRelative(directory, absolutePath));
}

export function isSnowLumaDeploymentReleaseFile(directory, absolutePath) {
  return SNOWLUMA_DEPLOYMENT_FILES.has(normalizedRelative(directory, absolutePath));
}

/**
 * Complete release bundles include auditable source/build tooling, but never
 * tests, local state, dependency trees, or arbitrary files from the checkout.
 * Callers still choose the reviewed source directories explicitly.
 */
export function isProjectSourceReleaseFile(directory, absolutePath) {
  const name = normalizedRelative(directory, absolutePath);
  if (name.split('/').some((segment) => segment.startsWith('.'))) return false;
  const dot = name.lastIndexOf('.');
  return dot !== -1 && PROJECT_SOURCE_EXTENSIONS.has(name.slice(dot));
}

/**
 * Full project archives are the deployable repository payload. They retain
 * CI/environment definitions and tests while excluding VCS metadata,
 * dependency trees, generated output directories, and local credentials.
 *
 * @param {string} directory
 * @param {string} absolutePath
 * @param {string} outputDirectory
 */
export function isRepositoryReleaseFile(directory, absolutePath, outputDirectory) {
  const name = normalizedRelative(directory, absolutePath);
  const segments = name.split('/');
  if (segments.some((segment) => ['.git', 'node_modules', 'coverage', 'release'].includes(segment))) return false;

  const outputRelative = normalizedRelative(outputDirectory, absolutePath);
  if (!outputRelative.startsWith('../') && outputRelative !== '..') return false;

  const leaf = segments.at(-1) ?? '';
  if ((leaf === '.env' || leaf.startsWith('.env.')) && !leaf.endsWith('.example')) return false;
  if (/^(?:config|bootstrap-credentials)\.(?:json|ya?ml)$/i.test(leaf)
    || /\.(?:db|db-shm|db-wal|log|map|sqlite|sqlite3|tmp)$/i.test(leaf)) return false;
  return true;
}
