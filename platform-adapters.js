/* global globalThis */

// Platform-specific editor identity and URL rules live behind this small
// adapter contract. Filling orchestration stays in background.js; adapters do
// not duplicate shared tab, API, or scheduling behavior.
(() => {
  class PlatformAdapter {
    constructor(platform, editorUrl) {
      this.platform = platform;
      this.editorUrl = editorUrl;
    }

    matchesEditor() {
      return false;
    }

    buildEditorUrl(article, contentId, helpers) {
      return helpers.withContentId(this.editorUrl, contentId);
    }
  }

  class LinkedInAdapter extends PlatformAdapter {
    constructor() {
      super('linkedin_pulse', 'https://www.linkedin.com/article/new/');
    }

    matchesEditor(url) {
      return typeof url === 'string' && /^https:\/\/www\.linkedin\.com\/(?:article|pulse)\//.test(url);
    }

    buildEditorUrl(article, contentId, helpers) {
      const urn = typeof article?.publish_as_urn === 'string' ? article.publish_as_urn.trim() : '';
      const author = helpers.linkedinEditorAuthorUrn(urn);
      const baseUrl = author
        ? `${this.editorUrl}?author=${encodeURIComponent(author)}`
        : this.editorUrl;
      return helpers.withContentId(baseUrl, contentId);
    }
  }

  class MediumAdapter extends PlatformAdapter {
    constructor() {
      super('medium', 'https://medium.com/new-story');
    }

    matchesEditor(url) {
      return typeof url === 'string' &&
        (url.startsWith(this.editorUrl) || /^https:\/\/medium\.com\/p\/[^/]+\/edit/.test(url));
    }
  }

  class SubstackAdapter extends PlatformAdapter {
    constructor() {
      super('substack', null);
    }

    matchesEditor(url) {
      return typeof url === 'string' && /^https:\/\/[^/]+\.substack\.com\/publish\/post(?:\/|$)/.test(url);
    }

    buildEditorUrl(article, contentId, helpers) {
      const domain = helpers.normalizeSubstackDomain(article?.substack_domain || '');
      if (!domain) return null;
      return helpers.withContentId(`https://${domain}.substack.com/publish/post`, contentId);
    }
  }

  const adapters = [new LinkedInAdapter(), new MediumAdapter(), new SubstackAdapter()];
  const byPlatform = new Map(adapters.map((adapter) => [adapter.platform, adapter]));

  function normalizePlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    if (platform === 'linkedin' || platform === 'linkedin_pulse') return 'linkedin_pulse';
    return byPlatform.has(platform) ? platform : platform;
  }

  function forPlatform(value) {
    return byPlatform.get(normalizePlatform(value)) || byPlatform.get('linkedin_pulse');
  }

  globalThis.ContentPulsePlatformAdapters = Object.freeze({
    forPlatform,
    normalizePlatform,
    platforms: Object.freeze(adapters.map((adapter) => adapter.platform)),
  });
})();
