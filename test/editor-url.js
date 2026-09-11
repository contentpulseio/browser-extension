const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');
const contentSource = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');
assert(source.includes('article?.publish_as_urn'));
assert(source.includes('function linkedinEditorAuthorUrn(urn)'));
assert(source.includes('urn ? `${LINKEDIN_EDITOR_URL}?author=${encodeURIComponent(urn)}` : LINKEDIN_EDITOR_URL'));
const helperStart = source.indexOf('function linkedinEditorAuthorUrn');
const helperEnd = source.indexOf('\n\nfunction isEditorUrl', helperStart);
const linkedinEditorAuthorUrn = new Function(
  `${source.slice(helperStart, helperEnd)}; return linkedinEditorAuthorUrn;`,
)();
assert.strictEqual(linkedinEditorAuthorUrn('urn:li:organization:123456'), 'urn:li:fsd_company:123456');
assert.strictEqual(linkedinEditorAuthorUrn('urn:li:fsd_company:123456'), 'urn:li:fsd_company:123456');
assert.strictEqual(
  `https://www.linkedin.com/article/new/?author=${encodeURIComponent(linkedinEditorAuthorUrn('urn:li:organization:123456'))}`,
  'https://www.linkedin.com/article/new/?author=urn%3Ali%3Afsd_company%3A123456',
);
assert(popupSource.includes('publish_as_urn: selectedWebsiteLinkedInAuthorUrn()'));
assert(contentSource.includes('function contentIdFromUrl()'));
assert(contentSource.includes("action: 'autoFillFromContentId'"));
assert(contentSource.includes('autoFillFromContentId();'));
assert(source.includes('async function autoFillFromContentId(contentId, tabId, requestedPlatform)'));
assert(source.includes("case 'autoFillFromContentId':"));
assert(source.includes('message.platform'), 'cp initial-load fill must preserve the current editor platform');
assert(source.includes('openAndFill(message.article)'));
assert(source.includes(".then((result) => sendResponse(result || { ok: true }))"));
assert(source.includes("return /^https:\\/\\/[^/]+\\.substack\\.com\\/publish\\/post(?:\\/|$)/.test(url);"));
assert(source.includes("if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return value.toLowerCase();"));
assert(fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8').includes('https://*.substack.com/publish/post*'));
assert(fs.readFileSync(path.resolve(__dirname, '..', 'medium-content.js'), 'utf8').includes("platform: 'medium'"));
assert(fs.readFileSync(path.resolve(__dirname, '..', 'substack-content.js'), 'utf8').includes("platform: 'substack'"));
console.log('PASS editor URL propagation and cp initial-load auto-fill wiring');
