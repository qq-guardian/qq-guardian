export const REQUIRED_GATES = Object.freeze([
  'quality',
  'unit',
  'contract-snowluma',
  'contract-napcat',
  'integration',
  'security',
  'production-build',
  'artifact-validation',
]);

export const REVIEWED_ACTION_PINS = Object.freeze({
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'pnpm/action-setup': 'ea17c68df8912ef543352723c149a84f56e3d413',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'github/codeql-action/init': '1c5b675653bb5c22dbe9b12b556ec555138e09fd',
  'actions/dependency-review-action': 'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  'gitleaks/gitleaks-action': 'e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e',
  'github/codeql-action/analyze': '1c5b675653bb5c22dbe9b12b556ec555138e09fd',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
});

const REVIEWED_JOB_PERMISSIONS = Object.freeze({
  quality: { contents: 'read' },
  unit: { contents: 'read' },
  'contract-snowluma': { contents: 'read' },
  'contract-napcat': { contents: 'read' },
  integration: { contents: 'read' },
  security: {
    actions: 'read',
    contents: 'read',
    'pull-requests': 'read',
    'security-events': 'write',
  },
  'production-build': { contents: 'read' },
  'artifact-validation': { actions: 'read', contents: 'read' },
});

export function verifyCiGovernance({ workflow, dependabot, packageJson }) {
  return [
    ...verifyWorkflow(workflow),
    ...verifyDependabot(dependabot),
    ...verifyPackageScripts(packageJson),
  ];
}

export function verifyWorkflow(workflow) {
  const errors = [];
  const activeWorkflow = stripYamlComments(workflow);
  const jobs = extractJobBlocks(activeWorkflow);
  if (!/^permissions: \{\}$/m.test(activeWorkflow)) errors.push('workflow must deny permissions by default with permissions: {}');

  for (const gate of REQUIRED_GATES) {
    const block = jobs.get(gate);
    if (!block) {
      errors.push(`missing stable CI gate ${gate}`);
      continue;
    }
    if (!new RegExp(`^    name: ${escapeRegex(gate)}$`, 'm').test(block)) errors.push(`${gate}: job name must remain stable`);
    if (!/^    timeout-minutes: [1-9][0-9]*$/m.test(block)) errors.push(`${gate}: missing timeout-minutes`);
    if (!/^    permissions:$/m.test(block)) errors.push(`${gate}: missing explicit job permissions`);
    verifyJobPermissions(gate, block, errors);
  }

  const actionUses = [...activeWorkflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^@\s]+)@([^\s#]+)/gm)];
  if (actionUses.length === 0) errors.push('workflow contains no actions');
  for (const [, action, reference] of actionUses) {
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      errors.push(`${action}: action reference must be an immutable 40-character commit SHA`);
      continue;
    }
    const reviewed = REVIEWED_ACTION_PINS[action];
    if (!reviewed) errors.push(`${action}: action is not in the reviewed pin allowlist`);
    else if (reference !== reviewed) errors.push(`${action}: action SHA differs from the reviewed pin`);
  }
  for (const action of Object.keys(REVIEWED_ACTION_PINS)) {
    if (!actionUses.some((match) => match[1] === action)) errors.push(`missing required action ${action}`);
  }

  requireRunCommands(jobs, 'quality', [
    'pnpm install --frozen-lockfile',
    'pnpm run typecheck',
    'pnpm run lint',
    'pnpm run format:check',
    'pnpm run test:tooling',
    'pnpm run verify:ci-governance',
  ], errors);
  requireRunCommands(jobs, 'unit', ['pnpm run test:unit'], errors);
  requireRunCommands(jobs, 'contract-snowluma', ['pnpm run verify:contracts:snowluma'], errors);
  requireRunCommands(jobs, 'contract-napcat', ['pnpm run verify:contracts:napcat'], errors);
  requireRunCommands(jobs, 'integration', ['pnpm run build', 'pnpm run test:integration'], errors);
  requireText(jobs, 'security', ['security-events: write', 'actions/dependency-review-action@', 'gitleaks/gitleaks-action@', 'github/codeql-action/init@', 'github/codeql-action/analyze@'], errors);
  requireRunCommands(jobs, 'security', ['pnpm audit --prod --audit-level=high'], errors);
  requireText(jobs, 'production-build', ['actions/upload-artifact@', 'dist-snowluma/', 'release/', 'if-no-files-found: error'], errors);
  requireRunCommands(jobs, 'production-build', ['pnpm run build', 'pnpm run verify:manifests', 'pnpm run package:archives', 'git diff --exit-code -- dist'], errors);
  requireText(jobs, 'artifact-validation', ['needs: production-build', 'actions/download-artifact@'], errors);
  requireRunCommands(jobs, 'artifact-validation', [
    'node scripts/prepare-artifact-validation.mjs',
    'test -f dist/index.mjs',
    'test -f dist/package.json',
    'test -f dist/plugin.json',
    'test -f dist-snowluma/index.mjs',
    'test -f dist-snowluma/package.json',
    'node scripts/verify-manifests.mjs',
    'node scripts/verify-release.mjs',
  ], errors);

  verifyCheckoutCredentials(activeWorkflow, errors);
  const installCount = (activeWorkflow.match(/pnpm install/g) ?? []).length;
  const frozenInstallCount = (activeWorkflow.match(/pnpm install --frozen-lockfile/g) ?? []).length;
  if (installCount !== frozenInstallCount) errors.push('every CI install must enforce the committed pnpm lockfile');
  return errors;
}

export function verifyDependabot(source) {
  const errors = [];
  const activeSource = stripYamlComments(source);
  const entries = extractDependabotEntries(activeSource);
  for (const ecosystem of ['github-actions', 'npm']) {
    const matching = entries.filter((entry) => entry.ecosystem === ecosystem);
    if (matching.length === 0) {
      errors.push(`Dependabot is missing ${ecosystem}`);
      continue;
    }
    for (const [index, entry] of matching.entries()) {
      if (!/^\s+target-branch:\s+["']?main["']?\s*$/m.test(entry.block)) {
        errors.push(`Dependabot ${ecosystem} entry ${index + 1} must target main`);
      }
      if (!/^\s+interval:\s+["']?weekly["']?\s*$/m.test(entry.block)) {
        errors.push(`Dependabot ${ecosystem} entry ${index + 1} must run weekly`);
      }
    }
  }
  return errors;
}

export function verifyPackageScripts(packageJson) {
  const scripts = packageJson?.scripts ?? {};
  const expected = {
    'verify:contracts:napcat': 'node scripts/verify-provider-contracts.mjs napcat',
    'verify:contracts:snowluma': 'node scripts/verify-provider-contracts.mjs snowluma',
    'verify:ci-governance': 'node scripts/verify-ci-governance.mjs',
  };
  return Object.entries(expected)
    .filter(([name, command]) => scripts[name] !== command)
    .map(([name]) => `package.json is missing the reviewed ${name} script`);
}

function extractJobBlocks(workflow) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of workflow.split(/\r?\n/)) {
    if (line === 'jobs:') {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const match = /^  ([a-z][a-z0-9-]*):$/.exec(line);
    if (match) {
      current = match[1];
      jobs.set(current, `${line}\n`);
    } else if (current) {
      jobs.set(current, `${jobs.get(current)}${line}\n`);
    }
  }
  return jobs;
}

function stripYamlComments(source) {
  return source.split(/\r?\n/).map((line) => {
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'" && line[index + 1] === "'") index += 1;
        else if (character === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (character === '\\') index += 1;
        else if (character === '"') quote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
        return line.slice(0, index).trimEnd();
      }
    }
    return line;
  }).join('\n');
}

function requireText(jobs, gate, required, errors) {
  const block = jobs.get(gate);
  if (!block) return;
  for (const text of required) {
    if (!block.includes(text)) errors.push(`${gate}: missing ${text}`);
  }
}

function requireRunCommands(jobs, gate, required, errors) {
  const block = jobs.get(gate);
  if (!block) return;
  const scripts = extractRunScripts(block);
  for (const command of required) {
    if (!scripts.some((script) => hasExecutableCommand(script, command))) {
      errors.push(`${gate}: missing executable command ${command}`);
    }
  }
}

function extractRunScripts(block) {
  const lines = block.split(/\r?\n/);
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const inline = match[2].trim();
    if (inline && inline !== '|' && inline !== '>') {
      scripts.push(inline);
      continue;
    }
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() && currentIndent <= indentation) break;
      if (currentIndent > indentation) body.push(line.slice(Math.min(line.length, indentation + 2)));
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

function hasExecutableCommand(script, expected) {
  return script.split(/\r?\n/)
    .flatMap((line) => line.split(/\s*(?:&&|;)\s*/))
    .map((segment) => segment.trim())
    .some((segment) => segment === expected);
}

function extractDependabotEntries(source) {
  const entries = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    const match = /^(\s*)-\s+package-ecosystem:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (match) {
      if (current) entries.push({ ecosystem: current.ecosystem, block: current.lines.join('\n') });
      current = { ecosystem: match[2], indent: match[1].length, lines: [line] };
      continue;
    }
    if (!current) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() && indentation <= current.indent) {
      entries.push({ ecosystem: current.ecosystem, block: current.lines.join('\n') });
      current = null;
      continue;
    }
    current.lines.push(line);
  }
  if (current) entries.push({ ecosystem: current.ecosystem, block: current.lines.join('\n') });
  return entries;
}

function verifyJobPermissions(gate, block, errors) {
  const expected = REVIEWED_JOB_PERMISSIONS[gate];
  if (!expected) return;
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '    permissions:');
  if (start === -1) return;
  const actual = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^      ([a-z-]+):\s*(read|write|none)$/.exec(line);
    if (match) {
      if (Object.hasOwn(actual, match[1])) errors.push(`${gate}: duplicate permission ${match[1]}`);
      actual[match[1]] = match[2];
      continue;
    }
    if (line.trim() && !line.startsWith('      ')) break;
  }
  for (const [permission, level] of Object.entries(actual)) {
    if (expected[permission] !== level) errors.push(`${gate}: unreviewed permission ${permission}: ${level}`);
  }
  for (const [permission, level] of Object.entries(expected)) {
    if (actual[permission] !== level) errors.push(`${gate}: permission ${permission} must be ${level}`);
  }
}

function verifyCheckoutCredentials(workflow, errors) {
  const lines = workflow.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const checkout = /^(\s*)-\s+uses:\s+actions\/checkout@/.exec(lines[index]);
    if (!checkout) continue;
    const stepIndent = checkout[1].length;
    const step = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const indentation = lines[cursor].match(/^\s*/)?.[0].length ?? 0;
      if (lines[cursor].trim() && indentation <= stepIndent) break;
      step.push(lines[cursor]);
    }
    const withIndent = ' '.repeat(stepIndent + 2);
    const optionIndent = ' '.repeat(stepIndent + 4);
    const hasWith = step.some((line) => line === `${withIndent}with:`);
    const credentialOptions = step.filter((line) => line.startsWith(`${optionIndent}persist-credentials:`));
    if (!hasWith || credentialOptions.length !== 1 || credentialOptions[0] !== `${optionIndent}persist-credentials: false`) {
      errors.push('every checkout step must set its own with.persist-credentials to false');
    }
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function desiredBranchProtection() {
  return {
    required_status_checks: {
      strict: true,
      contexts: [...REQUIRED_GATES],
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      bypass_pull_request_allowances: {
        users: [],
        teams: [],
        apps: [],
      },
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: true,
  };
}

export function evaluateBranchProtection(protection, signatures) {
  const errors = [];
  const status = protection?.required_status_checks;
  if (status?.strict !== true) errors.push('required status checks must be strict');
  const contexts = new Set([
    ...(status?.contexts ?? []),
    ...(status?.checks ?? []).map((check) => check.context),
  ]);
  const desiredContexts = new Set(REQUIRED_GATES);
  for (const gate of REQUIRED_GATES) {
    if (!contexts.has(gate)) errors.push(`required status check is missing ${gate}`);
  }
  for (const context of contexts) {
    if (!desiredContexts.has(context)) errors.push(`unexpected required status check ${context}`);
  }
  if (protection?.enforce_admins?.enabled !== true) errors.push('administrator enforcement is disabled');
  const reviews = protection?.required_pull_request_reviews;
  if (reviews?.required_approving_review_count !== 1) errors.push('exactly one approving review is required');
  if (reviews?.dismiss_stale_reviews !== true) errors.push('stale approvals must be dismissed');
  if (reviews?.require_code_owner_reviews !== false) errors.push('code-owner review policy differs from the reviewed setting');
  if (reviews?.require_last_push_approval !== true) errors.push('the last push must be approved by another reviewer');
  const bypasses = reviews?.bypass_pull_request_allowances ?? {};
  for (const kind of ['users', 'teams', 'apps']) {
    if ((bypasses[kind] ?? []).length > 0) errors.push(`pull-request review bypass is configured for ${kind}`);
  }
  if (protection?.required_linear_history?.enabled !== true) errors.push('linear history is disabled');
  if (protection?.required_conversation_resolution?.enabled !== true) errors.push('conversation resolution is disabled');
  if (protection?.allow_force_pushes?.enabled !== false) errors.push('force-push policy differs from the reviewed setting');
  if (protection?.allow_deletions?.enabled !== false) errors.push('branch-deletion policy differs from the reviewed setting');
  if (protection?.block_creations?.enabled !== false) errors.push('branch-creation policy differs from the reviewed setting');
  if (protection?.lock_branch?.enabled !== false) errors.push('branch lock must be disabled');
  if (protection?.allow_fork_syncing?.enabled !== true) errors.push('fork-sync policy differs from the reviewed setting');
  if (protection?.restrictions !== null) errors.push('push restrictions differ from the reviewed setting');
  if (signatures?.enabled !== true) errors.push('signed commits are not required');
  return errors;
}
