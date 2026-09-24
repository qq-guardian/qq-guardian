import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(ROOT, 'webui/release-view.js'), 'utf8');
const context = { URL, Set };
runInNewContext(source, context, { filename: 'webui/release-view.js' });
const view = context.GuardianReleaseView;

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
  }

  set innerHTML(_value) {
    throw new Error('The release renderer must not parse HTML');
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ currentTarget: this });
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

function createContainer() {
  const document = new FakeDocument();
  return new FakeElement(document, 'div');
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function renderedText(node) {
  return descendants(node).map((child) => child.textContent).join('');
}

const labels = {
  upToDate: (current) => `Current ${current}`,
  updateAvailable: (current, latest) => `Update ${current} -> ${latest}`,
  viewRelease: 'View release',
  install: (version) => `Install ${version}`,
  noBuildAsset: 'No verified build',
  manageVersions: 'Manage versions',
};

describe('release WebUI DOM trust boundary', () => {
  it('contains no markup parsing sink', () => {
    assert.doesNotMatch(source, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/);
  });

  it('rejects executable, credentialed, cross-origin, and custom-port URLs', () => {
    const rejected = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://github.com.evil.example/owner/repo/releases/tag/v1.2.3',
      'https://attacker@github.com/owner/repo/releases/tag/v1.2.3',
      'https://github.com:444/owner/repo/releases/tag/v1.2.3',
    ];
    for (const value of rejected) {
      assert.equal(view.safeGitHubReleaseUrl(value), null, value);
      assert.equal(view.safeDownloadUrl(value), null, value);
    }
    assert.equal(
      view.safeGitHubReleaseUrl('https://github.com/owner/repo/issues/1'),
      null,
    );
  });

  it('renders malicious release fields only as text and exposes no executable action', () => {
    const payload = '<img src=x onerror=globalThis.pwned=true>';
    const container = createContainer();
    let updateCalls = 0;
    view.renderUpdatePanel(container, {
      current: '1.0.0',
      latest: {
        version: payload,
        releaseUrl: 'javascript:globalThis.pwned=true',
        downloadUrl: 'javascript:globalThis.pwned=true',
        checksumUrl: 'data:text/html,<script>globalThis.pwned=true</script>',
      },
    }, labels, {
      onUpdate: () => { updateCalls += 1; },
      onManage: () => {},
    });

    const nodes = descendants(container);
    assert.match(renderedText(container), /<img src=x onerror=globalThis\.pwned=true>/);
    assert.equal(nodes.some((node) => node.tagName === 'A'), false);
    assert.equal(nodes.some((node) => node.className.includes('btn-primary')), false);
    assert.equal(nodes.some((node) => node.href?.startsWith('javascript:')), false);
    assert.equal(updateCalls, 0);
    assert.equal(context.pwned, undefined);
  });

  it('keeps an encoded GitHub path inert and passes only allowlisted asset URLs', () => {
    const encodedPayload = '%22%20onmouseover%3DglobalThis.pwned%3Dtrue';
    const container = createContainer();
    let selected;
    view.renderUpdatePanel(container, {
      current: '1.0.0',
      latest: {
        version: '1.2.3',
        releaseUrl: `https://github.com/owner/repo/releases/tag/${encodedPayload}`,
        downloadUrl: 'https://github.com/owner/repo/releases/download/v1.2.3/plugin.zip',
        checksumUrl: 'https://release-assets.githubusercontent.com/checksum',
      },
    }, labels, {
      onUpdate: (release) => { selected = release; },
      onManage: () => {},
    });

    const nodes = descendants(container);
    const link = nodes.find((node) => node.tagName === 'A');
    const install = nodes.find((node) => node.className.includes('btn-primary'));
    assert.ok(link);
    assert.match(link.href, /^https:\/\/github\.com\/owner\/repo\/releases\/tag\//);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.ok(install);
    install.dispatch('click');
    assert.equal(selected.downloadUrl, 'https://github.com/owner/repo/releases/download/v1.2.3/plugin.zip');
    assert.equal(selected.checksumUrl, 'https://release-assets.githubusercontent.com/checksum');
    assert.equal(context.pwned, undefined);
  });

  it('renders hostile row metadata as text and selects by object identity', () => {
    const release = {
      tag: '\" data-tag=\"attacker',
      version: '<svg/onload=globalThis.pwned=true>',
      publishedAt: '<script>globalThis.pwned=true</script>',
    };
    const container = createContainer();
    let selected;
    view.renderVersionRows(container, [release], {
      labels: { noVersions: 'None', current: 'Current', downgrade: 'Downgrade' },
      compare: () => 'newer',
      formatDate: (value) => value,
      isSelected: () => false,
      onSelect: (value) => { selected = value; },
    });

    const row = descendants(container).find((node) => node.className === 'vm-row');
    assert.ok(row);
    assert.match(renderedText(container), /<svg\/onload=globalThis\.pwned=true>/);
    assert.match(renderedText(container), /<script>globalThis\.pwned=true<\/script>/);
    assert.equal(Object.hasOwn(row, 'dataset'), false);
    row.dispatch('click');
    assert.equal(selected, release);
    assert.equal(context.pwned, undefined);
  });
});
