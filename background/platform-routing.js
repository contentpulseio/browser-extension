// ContentPulse background: platform routing.
function editorUrlWithContentId(url, contentId) {
  const id = String(contentId || '').trim();
  if (!id) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cp', id);
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

// LinkedIn's API identifies Company Pages with an organization URN, but the
// Article editor's `author` query parameter expects the frontend `fsd_company`
// entity URN. Keep the API/storage value unchanged and translate it only at
// this browser boundary.
function linkedinEditorAuthorUrn(urn) {
  const value = typeof urn === 'string' ? urn.trim() : '';
  return value.replace(/^urn:li:organization:(\d+)$/, 'urn:li:fsd_company:$1');
}

function isEditorUrl(url) {
  return ContentPulsePlatformAdapters.forPlatform('linkedin_pulse').matchesEditor(url);
}

function isMediumEditorUrl(url) {
  return ContentPulsePlatformAdapters.forPlatform('medium').matchesEditor(url);
}

// A LinkedIn article is live once its URL settles on the /pulse/<slug> permalink.
// The editor (/article/new/) and the in-progress draft never match this, so a
// later transition to a /pulse/ URL is a reliable "published" signal.
function publishedLinkedInUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https:\/\/www\.linkedin\.com\/pulse\/[^/?#]+/);
  return match ? match[0] : null;
}

// Medium story URLs: https://medium.com/@user/slug-hexid or
// https://medium.com/publication/slug-hexid. The new-story editor and edit
// URLs (/new-story, /p/xxx/edit) don't match.
function publishedMediumUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.includes('/new-story') || url.includes('/edit') || url.includes('/settings')) return null;
  const match = url.match(/^https:\/\/medium\.com\/(@[^/]+|[^/]+)\/[a-z0-9][\w-]+-[0-9a-f]{8,}/i);
  return match ? match[0] : null;
}

function isSubstackEditorUrl(url) {
  return ContentPulsePlatformAdapters.forPlatform('substack').matchesEditor(url);
}

function publishedSubstackUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.includes('/publish/')) return null;
  const match = url.match(/^https:\/\/[^/]+\.substack\.com\/p\/[a-z0-9][\w-]+/i);
  return match ? match[0] : null;
}

// Tabs we are watching for a publish navigation: tabId -> {contentId, platform, initialUrl}.
// After the user clicks "Fill in editor" we keep an eye on that editor tab; when it
// navigates to the live /pulse/ URL we auto-record the publication. Manual paste in
// the popup remains the fallback when auto-capture cannot fire (popup-only flows,
// edits of an existing article, or unexpected redirects).
const publishWatch = new Map();

function watchTabForPublish(tabId, contentId, platform, initialUrl, shareText, editUrl) {
  if (!tabId || !contentId || !platform) return;
  publishWatch.set(tabId, { contentId, platform, initialUrl: initialUrl || '', shareText: shareText || '', editUrl: editUrl || '' });
  log('[ContentPulse][bg] watching tab', tabId, 'for publish of content', contentId);
}
