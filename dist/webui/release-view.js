(function installGuardianReleaseView(root) {
  'use strict';

  const DOWNLOAD_HOSTS = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'codeload.github.com',
    'releases.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
  ]);

  function safeUrl(value, allowed) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (!allowed(url)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function safeGitHubReleaseUrl(value) {
    return safeUrl(value, (url) =>
      url.hostname === 'github.com'
      && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases(?:\/|$)/.test(url.pathname)
    );
  }

  function safeDownloadUrl(value) {
    return safeUrl(value, (url) => DOWNLOAD_HOSTS.has(url.hostname));
  }

  function create(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  /** Render the update summary without interpreting any release metadata as
   *  markup, an attribute fragment, a style, or a dynamic handler. */
  function renderUpdatePanel(container, data, labels, handlers) {
    const document = container.ownerDocument;
    const current = String(data?.current ?? '');
    const latest = data?.latest && typeof data.latest === 'object' ? data.latest : null;
    const children = [];

    children.push(create(
      document,
      'p',
      '',
      latest
        ? labels.updateAvailable(current, String(latest.version ?? ''))
        : labels.upToDate(current),
    ));

    if (latest) {
      const actions = create(document, 'div');
      actions.style.cssText = 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap';

      const releaseUrl = safeGitHubReleaseUrl(latest.releaseUrl);
      if (releaseUrl) {
        const link = create(document, 'a', 'btn btn-outline btn-sm', labels.viewRelease);
        link.href = releaseUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.appendChild(link);
      }

      const downloadUrl = safeDownloadUrl(latest.downloadUrl);
      const checksumUrl = safeDownloadUrl(latest.checksumUrl);
      if (downloadUrl && checksumUrl) {
        const button = create(
          document,
          'button',
          'btn btn-primary btn-sm',
          labels.install(String(latest.version ?? '')),
        );
        button.type = 'button';
        button.addEventListener('click', () => handlers.onUpdate({
          ...latest,
          downloadUrl,
          checksumUrl,
        }));
        actions.appendChild(button);
      } else {
        actions.appendChild(create(document, 'span', 'badge badge-yellow', labels.noBuildAsset));
      }
      children.push(actions);
    }

    const manageWrap = create(document, 'div');
    manageWrap.style.cssText = 'margin-top:14px';
    const manage = create(document, 'button', 'btn btn-outline btn-sm', labels.manageVersions);
    manage.type = 'button';
    manage.addEventListener('click', handlers.onManage);
    manageWrap.appendChild(manage);
    children.push(manageWrap);
    container.replaceChildren(...children);
  }

  /** Render selectable release rows. Object identity is captured in a closure;
   *  the untrusted tag is never copied into data-* or queried back from DOM. */
  function renderVersionRows(container, items, options) {
    const document = container.ownerDocument;
    if (items.length === 0) {
      container.replaceChildren(create(document, 'div', 'empty', options.labels.noVersions));
      return;
    }

    const rows = items.map((release) => {
      const row = create(document, 'div', 'vm-row');
      row.style.cssText = 'padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)';
      if (options.isSelected(release)) row.style.background = 'rgba(79,124,255,.12)';

      row.appendChild(create(document, 'span', '', `v${String(release.version ?? '')}`));
      const detail = create(document, 'span');
      detail.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)';
      detail.appendChild(create(document, 'span', '', options.formatDate(release.publishedAt)));
      const comparison = options.compare(String(release.version ?? ''));
      if (comparison === 'current') {
        detail.appendChild(create(document, 'span', 'badge badge-green', options.labels.current));
      } else if (comparison === 'older') {
        detail.appendChild(create(document, 'span', 'badge badge-yellow', options.labels.downgrade));
      }
      row.appendChild(detail);
      row.addEventListener('click', () => options.onSelect(release));
      return row;
    });
    container.replaceChildren(...rows);
  }

  root.GuardianReleaseView = Object.freeze({
    renderUpdatePanel,
    renderVersionRows,
    safeDownloadUrl,
    safeGitHubReleaseUrl,
  });
})(globalThis);
