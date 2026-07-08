/**
 * ContentPulse Reddit Data Extractor
 *
 * Extracts subreddit metadata, post data, and comments from Reddit pages.
 * Can be injected via browser console or loaded as a content script.
 *
 * Usage (browser console on any reddit.com page):
 *   - Paste this entire script
 *   - Call: extractRedditData()
 *   - The JSON result is copied to clipboard and logged to console
 */

(function () {
  'use strict';

  function extractSubredditInfo() {
    const header = document.querySelector('shreddit-subreddit-header');
    if (!header) return null;

    const name =
      header.getAttribute('name') ||
      header.getAttribute('prefixed-name')?.replace('r/', '') ||
      null;

    const title = header.querySelector('#title')?.textContent?.trim() || name;
    const description = header.querySelector('#description')?.textContent?.trim() || '';
    const weeklyVisitors = parseInt(header.getAttribute('weekly-active-users') || '0', 10);
    const weeklyContributions = parseInt(header.getAttribute('weekly-contributions') || '0', 10);
    const subscriberEl = header.querySelector('[slot="subscribers-count"]');
    const subscribers = subscriberEl?.textContent?.trim() || null;

    return {
      name,
      title,
      description,
      subscribers,
      weekly_visitors: weeklyVisitors,
      weekly_contributions: weeklyContributions,
    };
  }

  function extractRules() {
    const rulesContainer = document.querySelector(
      '.px-md .uppercase.text-12'
    );
    if (!rulesContainer) {
      const allH2 = document.querySelectorAll('h2');
      for (const h2 of allH2) {
        if (h2.textContent?.includes('Rules')) {
          return extractRulesFromParent(h2.closest('.px-md') || h2.parentElement);
        }
      }
      return [];
    }

    return extractRulesFromParent(rulesContainer.closest('.px-md'));
  }

  function extractRulesFromParent(container) {
    if (!container) return [];
    const rules = [];
    const sections = container.querySelectorAll('faceplate-expandable-section-helper');

    sections.forEach((section) => {
      const numberEl = section.querySelector(
        '.text-neutral-content-weak.text-14.font-normal'
      );
      const titleEl = section.querySelector('h2.i18n-translatable-text');
      const descEl = section.querySelector(
        '.i18n-translatable-text.ms-xl .md p'
      );

      const number = numberEl?.textContent?.trim() || '';
      const ruleTitle = titleEl?.textContent?.trim() || '';
      const ruleDesc = descEl?.textContent?.trim() || '';

      if (ruleTitle) {
        rules.push({
          number: parseInt(number, 10) || rules.length + 1,
          title: ruleTitle,
          description: ruleDesc,
        });
      }
    });

    return rules;
  }

  function extractPostData() {
    const post = document.querySelector('shreddit-post');
    if (!post) return null;

    const titleEl = document.querySelector('[id^="post-title-"]');
    const bodyEl = post.querySelector('[slot="text-body"] .md');

    return {
      id: post.getAttribute('id') || null,
      title: titleEl?.textContent?.trim() || post.getAttribute('post-title') || '',
      author: post.getAttribute('author') || '',
      subreddit: post.getAttribute('subreddit-prefixed-name') || '',
      score: parseInt(post.getAttribute('score') || '0', 10),
      comment_count: parseInt(post.getAttribute('comment-count') || '0', 10),
      created: post.getAttribute('created-timestamp') || null,
      permalink: post.getAttribute('permalink') || null,
      post_type: post.getAttribute('post-type') || 'text',
      body: bodyEl?.textContent?.trim() || null,
    };
  }

  function extractComments() {
    const commentEls = document.querySelectorAll('shreddit-comment');
    const comments = [];

    commentEls.forEach((el) => {
      const author = el.getAttribute('author') || '';
      const score = parseInt(el.getAttribute('score') || '0', 10);
      const created = el.getAttribute('created') || null;
      const depth = parseInt(el.getAttribute('depth') || '0', 10);
      const thingId = el.getAttribute('thingid') || '';
      const permalink = el.getAttribute('permalink') || null;

      const bodyEl = el.querySelector('.md');
      const body = bodyEl?.textContent?.trim() || '';

      if (author && body) {
        comments.push({
          id: thingId,
          author,
          body,
          score,
          depth,
          created,
          permalink: permalink
            ? `https://www.reddit.com${permalink}`
            : null,
        });
      }
    });

    return comments;
  }

  function detectPageType() {
    const url = window.location.href;
    if (url.includes('/comments/')) return 'post';
    if (url.match(/reddit\.com\/r\/[^/]+\/?(\?|$)/)) return 'subreddit';
    return 'unknown';
  }

  function extractRedditData() {
    const pageType = detectPageType();
    const result = {
      extracted_at: new Date().toISOString(),
      url: window.location.href,
      page_type: pageType,
      subreddit: extractSubredditInfo(),
      rules: extractRules(),
    };

    if (pageType === 'post') {
      result.post = extractPostData();
      result.comments = extractComments();
    }

    try {
      const json = JSON.stringify(result, null, 2);
      navigator.clipboard.writeText(json).then(
        () => console.log('%c[ContentPulse] Data copied to clipboard!', 'color: #7c3aed; font-weight: bold'),
        () => console.warn('[ContentPulse] Clipboard write failed, check console output')
      );
      console.log('%c[ContentPulse] Extracted Reddit Data:', 'color: #7c3aed; font-weight: bold');
      console.log(result);
      console.log('%cJSON:', 'color: #7c3aed; font-weight: bold');
      console.log(json);
    } catch (e) {
      console.error('[ContentPulse] Error:', e);
    }

    return result;
  }

  window.__cpExtractRedditData = extractRedditData;

  if (typeof window.__cpAutoExtract !== 'undefined' && window.__cpAutoExtract) {
    extractRedditData();
  }

  console.log(
    '%c[ContentPulse Reddit Extractor] Ready. Run: extractRedditData() or window.__cpExtractRedditData()',
    'color: #7c3aed; font-weight: bold; font-size: 14px'
  );

  extractRedditData();
})();
