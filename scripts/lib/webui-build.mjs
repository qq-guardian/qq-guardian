const INLINE_APPLICATION = /<script>\r?\n([\s\S]*?)\r?\n<\/script>/;
const DEVELOPMENT_SCRIPT_POLICY = "script-src 'self' 'unsafe-inline'";
const PRODUCTION_SCRIPT_POLICY = "script-src 'self'";
const INLINE_SCRIPT_OPENING = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;

/** Extract the legacy monolithic application script while producing a
 * deployable document whose CSP and markup both prohibit inline JavaScript. */
export function buildProductionWebUi(source) {
  if (typeof source !== 'string') throw new TypeError('WebUI source must be a string');
  const inlineScript = source.match(INLINE_APPLICATION);
  if (!inlineScript) throw new Error('webui/index.html must contain one build-extractable inline application script');
  if (!source.includes(DEVELOPMENT_SCRIPT_POLICY)) {
    throw new Error('webui/index.html must declare the expected development script policy');
  }

  const html = source
    .replace(DEVELOPMENT_SCRIPT_POLICY, PRODUCTION_SCRIPT_POLICY)
    .replace(inlineScript[0], '<script src="../files/static/app.js"></script>');
  if (INLINE_SCRIPT_OPENING.test(html)) {
    throw new Error('Production WebUI must not contain inline script blocks');
  }
  if (/script-src[^;\"]*'unsafe-inline'/.test(html)) {
    throw new Error('Production WebUI CSP must not allow inline scripts');
  }
  return { html, appScript: `${inlineScript[1]}\n` };
}
