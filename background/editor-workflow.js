// ContentPulse background: editor workflow.
function cpPublishCapturedToast(message) {
  try {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;border-radius:8px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;background:#0a7d33;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:320px';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  } catch (e) {}
}

// Persistent link from the editor page back to the article in the ContentPulse
// dashboard (where corrections create a new version). Injected after a fill and
// re-injected on full page loads of the watched editor tab.
function cpShowEditLink(url) {
  try {
    if (!/^https:\/\//i.test(String(url))) return;
    const existing = document.getElementById('cp-edit-link');
    if (existing) {
      existing.href = url;
      return;
    }
    const a = document.createElement('a');
    a.id = 'cp-edit-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Edit in ContentPulse';
    a.style.cssText =
      'position:fixed;bottom:20px;left:20px;z-index:2147483647;padding:10px 14px;border-radius:8px;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;background:#1f2937;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.25)';
    document.body.appendChild(a);
  } catch (e) {}
}

function injectEditLink(tabId, editUrl) {
  if (!tabId || !editUrl) return;
  try {
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: cpShowEditLink, args: [editUrl] }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const watch = publishWatch.get(tabId);
  if (!watch) return;
  if (changeInfo.status === 'complete') injectEditLink(tabId, watch.editUrl);

  const currentUrl = changeInfo.url || tab?.url || '';
  const liveUrl = publishedLinkedInUrl(currentUrl) || publishedMediumUrl(currentUrl) || publishedSubstackUrl(currentUrl);
  // Ignore the editor and any URL identical to where we started filling; only a
  // transition to a real permalink counts as published.
  if (!liveUrl || currentUrl === watch.initialUrl) return;

  publishWatch.delete(tabId);

  // The publish navigation may replace the page (destroying the in-page
  // watcher armed at fill time), and LinkedIn opens/keeps its share dialog
  // around this transition - so re-arm the share fill on the live page.
  if (watch.shareText) {
    injectShareDialogFill(tabId, watch.shareText, false);
  }

  const res = await recordPublication(watch.contentId, watch.platform, liveUrl);
  if (res.ok) {
    log('[ContentPulse][bg] auto-captured publish URL', liveUrl);
    try {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: cpPublishCapturedToast,
        args: ['ContentPulse: publish link saved to your workspace'],
      });
    } catch (e) {}
  } else {
    warn('[ContentPulse][bg] auto-capture could not save publish URL', res.error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  publishWatch.delete(tabId);
  directFillTabs.delete(tabId);
  backgroundFillTabs.delete(tabId);
});

function claimBackgroundFill(tabId, contentId) {
  if (!tabId) return;
  backgroundFillTabs.set(tabId, String(contentId || ''));
  setTimeout(() => backgroundFillTabs.delete(tabId), 30_000);
}

async function autoFillFromContentId(contentId, tabId, requestedPlatform, debugEnabled = false) {
  const claimedContentId = tabId ? backgroundFillTabs.get(tabId) : null;
  if (claimedContentId && claimedContentId === String(contentId || '')) {
    return { ok: true, claimed: true, contentId };
  }

  const result = await getArticle(contentId);
  if (!result?.ok || !result.article) return result || { ok: false, error: 'Article was not found.' };

  // The page itself is the platform signal for this initial-load path. This
  // prevents a stale publish_channel value from routing a LinkedIn URL into
  // the Medium/Substack branch.
  const platform = normalizeExtensionPlatform(requestedPlatform || 'linkedin_pulse');
  const article = {
    ...result.article,
    platform: ['linkedin_pulse', 'medium', 'substack'].includes(platform) ? platform : 'linkedin_pulse',
  };
  if (tabId) {
    directFillTabs.set(tabId, Date.now());
    setTimeout(() => directFillTabs.delete(tabId), 20_000);
  }
  openAndFill(article, tabId || null, debugEnabled);
  return { ok: true, contentId: article.id, title: article.title };
}

async function openAndFill(article, preferredTabId = null, debugEnabled = false) {
  const title = article?.title || '';
  const bodyHtml = article?.body_html || article?.body || '';
  const contentId = article?.id || null;
  const adapter = ContentPulsePlatformAdapters.forPlatform(
    normalizeExtensionPlatform(article?.platform || article?.publish_channel || 'linkedin_pulse'),
  );
  const platform = adapter.platform;
  const imageUrl = typeof article?.image_url === 'string' ? article.image_url.trim() : '';
  const credit = typeof article?.credit === 'string' ? article.credit.trim() : '';
  const taxonomyHashtags = normalizeLinkedInHashtags(article?.tags || []).join(' ');
  const sharePost = article?.share_post && typeof article.share_post === 'object'
    ? {
        ...article.share_post,
        hashtags: String(article.share_post.hashtags || '').trim() || taxonomyHashtags,
      }
    : article?.share_post;
  const shareText = composeShareText(sharePost);
  const editUrl = typeof article?.dashboard_url === 'string' ? article.dashboard_url : '';
  const clipboardPrepared = article?.clipboard_prepared === true;
  const clipboardToken = article?.clipboard_token || '';
  log('[ContentPulse][bg] openAndFill ->', title, 'platform:', platform);

  // Table PNGs are generated by a separate authenticated endpoint. Resolve
  // them once per fill and reuse the downloaded bytes for all platform flows.
  const tableImagesPromise = /<table\b/i.test(bodyHtml) ? fetchTableImages(contentId) : Promise.resolve([]);

  const queryTargetTab = () => new Promise((resolve) => {
    if (preferredTabId) {
      chrome.tabs.get(preferredTabId, (tab) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });

  const createEditorTab = (url, onCreated) =>
    new Promise((resolve) => {
      if (!url) {
        resolve({ ok: false, error: 'No editor URL is configured for this platform.' });
        return;
      }
      chrome.tabs.create({ url }, (tab) => {
        const error = chrome.runtime.lastError;
        if (error || !tab?.id) {
          resolve({ ok: false, error: error?.message || 'The editor tab could not be opened.' });
          return;
        }
        onCreated(tab);
        resolve({ ok: true, tabId: tab.id });
      });
    });

  // Strip HTML to plain text (service worker has no DOMParser).
  const stripToText = (html) => {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  };

  // ── Medium flow ──────────────────────────────────────────────────
  if (adapter.platform === 'medium') {
    const mediumImageUrl = typeof article?.image_url === 'string' ? article.image_url.trim() : '';
    const mediumTags = article?.tags || [];
    const mediumCategories = article?.categories || [];
    const canonicalUrl = article?.article_url || '';
    const seo = article?.seo || {};
    const seoTitle = seo.meta_title || '';
    const seoDescription = seo.meta_description || '';

    // Keep opening/navigation independent from authenticated table-image
    // downloads. The editor must open immediately, while the body assets can
    // finish resolving before the page fill starts.
    const mediumPrepared = tableImagesPromise.then(async (tableImages) => {
      const mediumBodySource = replaceTablesWithImageFiguresForMedium(bodyHtml, tableImages);
      const mediumInlineImages = buildInlineImageMeta(bodyHtml, tableImages);
      const heroCaption = (article?.credit || '').trim().slice(0, 250);
      const heroAlt = (title || heroCaption || 'Featured image').trim().slice(0, 500);
      const heroAlreadyInBody = mediumImageUrl && mediumInlineImages.some((image) => image.url === mediumImageUrl);
      const heroHtml =
        mediumImageUrl && !heroAlreadyInBody
          ? `<figure><img src="${escapeHtml(mediumImageUrl)}" alt="${escapeHtml(heroAlt)}">${heroCaption ? `<figcaption>${escapeHtml(heroCaption)}</figcaption>` : ''}</figure>`
          : '';
      const mediumBodyHtml = `${heroHtml}${mediumBodySource}`;
      const mediumImageMeta = [
        ...(heroHtml ? [{ url: mediumImageUrl, caption: heroCaption, alt: heroAlt }] : []),
        ...mediumInlineImages,
      ];
      const preparedImages = await prepareMediumImagesForPaste(mediumBodyHtml, mediumImageMeta);
      if (!preparedImages.ok) return preparedImages;
      return {
        ok: true,
        mediumBodyHtml: preparedImages.html,
        bodyText: stripToText(preparedImages.html),
        mediumImageMeta: preparedImages.imageMeta,
        imageCount: preparedImages.imageCount,
      };
    });

    const mediumAfterEditorFill = async (tabId) => {
      await mediumAfterFill(tabId, mediumTags, mediumCategories, canonicalUrl, seoTitle, seoDescription);
    };
    const fillMediumTab = async (tabId) => {
      const prepared = await mediumPrepared;
      if (!prepared.ok) {
        warn('[ContentPulse][bg] Medium images could not be prepared', prepared.failures || prepared.error);
        await mediumPageShowError(tabId, prepared.error || 'Medium images could not be prepared for upload.');
        return;
      }
      const fillResult = await mediumPageFill(tabId, title, prepared.mediumBodyHtml, prepared.bodyText, prepared.mediumImageMeta);
      if (!fillResult?.ok) return;
      await mediumAfterEditorFill(tabId);
    };

    const activeTab = await queryTargetTab();
    if (activeTab && isMediumEditorUrl(activeTab.url)) {
      log('[ContentPulse][bg] active tab is Medium editor, filling in place');
      watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, '', editUrl);
      injectEditLink(activeTab.id, editUrl);
      fillMediumTab(activeTab.id);
      return { ok: true, tabId: activeTab.id, reused: true };
    }

    const editorUrl = adapter.buildEditorUrl(article, contentId, { withContentId: editorUrlWithContentId });
    log('[ContentPulse][bg] opening Medium editor', editorUrl);
    return createEditorTab(editorUrl, (tab) => {
      const targetTabId = tab.id;
      claimBackgroundFill(targetTabId, contentId);
      watchTabForPublish(targetTabId, contentId, platform, editorUrl, '', editUrl);

      let readyHandled = false;
      const listener = (tabId, changeInfo) => {
        if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') return;
        readyHandled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        // Medium's editor needs extra time to bootstrap ProseMirror.
        setTimeout(() => {
          if (directFillTabs.has(targetTabId)) {
            directFillTabs.delete(targetTabId);
            return;
          }
          fillMediumTab(targetTabId);
        }, 2000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
    });
  }

  // ── Substack flow ─────────────────────────────────────────────────
  if (adapter.platform === 'substack') {
    const subtitle = article?.subtitle || article?.seo?.meta_description || '';
    const thumbnailDescription = article?.seo?.meta_description || credit || title;
    const substackPrepared = tableImagesPromise.then((tableImages) => {
      const substackBodyHtml = replaceTablesWithImageFigures(bodyHtml, tableImages);
      const heroCaption = credit.slice(0, 250);
      const heroAlt = (title || heroCaption || 'Featured image').trim().slice(0, 500);
      const substackBodyWithHeroHtml = buildSubstackHeroBody(substackBodyHtml, imageUrl, heroAlt, heroCaption);
      return {
        substackBodyHtml,
        substackBodyWithHeroHtml,
        bodyText: stripToText(substackBodyHtml),
        bodyTextWithHero: stripToText(substackBodyWithHeroHtml),
        substackInlineImages: buildInlineImageMeta(bodyHtml, tableImages),
        hasHeroInBody: substackBodyWithHeroHtml !== substackBodyHtml,
      };
    });
    const doFill = async (tabId) => {
      const prepared = await substackPrepared;
      // Try the thumbnail while Substack's native file-settings input is
      // idle. If it rejects the synthetic file event, include the hero in the
      // initial paste so Substack cannot append it after existing blocks.
      let coverResult = { ok: false };
      if (imageUrl) {
        coverResult = await substackCoverImage(tabId, imageUrl, title, thumbnailDescription);
      }
      const includeHeroInBody = !coverResult?.ok && prepared.hasHeroInBody;
      const fillHtml = includeHeroInBody ? prepared.substackBodyWithHeroHtml : prepared.substackBodyHtml;
      const fillText = includeHeroInBody ? prepared.bodyTextWithHero : prepared.bodyText;
      const expectedImages = prepared.substackInlineImages.length + (includeHeroInBody ? 1 : 0);
      await substackPageFill(tabId, title, subtitle, fillHtml, fillText, expectedImages, article?.tags || []);
    };

    const activeTab = await queryTargetTab();
    if (activeTab && isSubstackEditorUrl(activeTab.url)) {
      log('[ContentPulse][bg] active tab is Substack editor, filling in place');
      watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, '', editUrl);
      injectEditLink(activeTab.id, editUrl);
      doFill(activeTab.id);
      return { ok: true, tabId: activeTab.id, reused: true };
    }

    log('[ContentPulse][bg] no Substack editor in the active tab');
    const editorUrl = adapter.buildEditorUrl(article, contentId, {
      withContentId: editorUrlWithContentId,
      normalizeSubstackDomain,
    });

    if (!editorUrl) {
      log('[ContentPulse][bg] no Substack domain configured, cannot open editor');
      return { ok: false, error: 'No Substack publication domain is configured for this article.' };
    }

    return createEditorTab(editorUrl, (tab) => {
      const targetTabId = tab.id;
      claimBackgroundFill(targetTabId, contentId);
      watchTabForPublish(targetTabId, contentId, platform, editorUrl, '', editUrl);

      let readyHandled = false;
      const listener = (tabId, changeInfo) => {
        if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') return;
        readyHandled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          if (directFillTabs.has(targetTabId)) {
            directFillTabs.delete(targetTabId);
            return;
          }
          doFill(targetTabId);
        }, 2000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
    });
  }

  // ── LinkedIn flow (default) ──────────────────────────────────────
  // LinkedIn forces a share-post dialog when the Pulse article is published;
  // arm a watcher on the editor tab so the prepared copy is filled in the
  // moment that dialog opens.
  const armShareFill = (tabId) => {
    if (shareText) injectShareDialogFill(tabId, shareText, false);
  };

  // The article's website carries the connected LinkedIn profile/page name;
  // verify/switch the editor's "Publish as" entity to it after the fill.
  const publishAs = article?.publish_as || '';
  const linkedinPrepared = tableImagesPromise.then((tableImages) => {
    const linkedinBodySource = removeTablesForLinkedIn(bodyHtml);
    const linkedinBodyWithHero = addLinkedInHeroDescription(linkedinBodySource, article?.hero_description || '');
    const linkedinBodyHtml = addLinkedInTitleSpacing(formatLinkedInTagsHtml(linkedinBodyWithHero, article?.tags || []));
    // Build image metadata from the original body so generated table PNGs keep
    // their source order and heading anchors even though the table HTML itself
    // was removed from LinkedIn's pasted body.
    const seo = article?.seo || null;
    return {
      linkedinBodyHtml,
      inlineImages: buildInlineImageMeta(bodyHtml, tableImages),
      seo,
      hasSeo: !!(seo && ((seo.meta_title || '').trim() || (seo.meta_description || '').trim())),
    };
  });
  // Run sequentially - each step opens its own dialog on the page and they
  // would fight each other if fired at the same time. Order: publisher ->
  // cover image + credit -> inline images/captions -> SEO settings (filled and saved).
  const afterFill = async (tabId, prepared) => {
    if (publishAs) await pageEnsurePublisher(tabId, publishAs);
    if (imageUrl) await pageFillCoverImage(tabId, imageUrl, credit);
    if (prepared.inlineImages.length) await pageFillInlineImages(tabId, prepared.inlineImages, debugEnabled);
    if (prepared.hasSeo) await pageFillSeo(tabId, prepared.seo.meta_title || '', prepared.seo.meta_description || '');
  };
  const fillLinkedInTab = async (tabId) => {
    const prepared = await linkedinPrepared;
    const systemClipboardReady = clipboardPrepared || await waitForClipboardPrepared(clipboardToken);
    await pageFill(tabId, title, prepared.linkedinBodyHtml, '', false, systemClipboardReady, debugEnabled);
    await afterFill(tabId, prepared);
  };

  const activeTab = await queryTargetTab();
  if (activeTab && isEditorUrl(activeTab.url)) {
    log('[ContentPulse][bg] active tab is already the editor, filling in place');
    watchTabForPublish(activeTab.id, contentId, platform, activeTab.url, shareText, editUrl);
    injectEditLink(activeTab.id, editUrl);
    fillLinkedInTab(activeTab.id);
    armShareFill(activeTab.id);
    return { ok: true, tabId: activeTab.id, reused: true };
  }

  log('[ContentPulse][bg] no editor in the active tab, opening a new one');
  // If we already learned this publisher's URN, open the editor publishing
  // as it right away (?author=<urn>) - no Publish-as clicking needed.
  const configuredUrn = typeof article?.publish_as_urn === 'string' ? article.publish_as_urn.trim() : '';
  const urn = linkedinEditorAuthorUrn(configuredUrn);
  const editorUrl = adapter.buildEditorUrl(article, contentId, {
    withContentId: editorUrlWithContentId,
    linkedinEditorAuthorUrn,
  });
  if (urn) log('[ContentPulse][bg] opening editor with configured author urn', urn);
  return createEditorTab(editorUrl, (tab) => {
    const targetTabId = tab.id;
    claimBackgroundFill(targetTabId, contentId);
    watchTabForPublish(targetTabId, contentId, platform, editorUrl, shareText, editUrl);

    let readyHandled = false;
    const listener = (tabId, changeInfo) => {
      if (readyHandled || tabId !== targetTabId || changeInfo.status !== 'complete') {
        return;
      }
      readyHandled = true;
      log('[ContentPulse][bg] editor tab ready, filling via executeScript');
      chrome.tabs.onUpdated.removeListener(listener);
      if (directFillTabs.has(targetTabId)) {
        directFillTabs.delete(targetTabId);
        return;
      }
      linkedinPrepared.then(async (prepared) => {
        const systemClipboardReady = clipboardPrepared || await waitForClipboardPrepared(clipboardToken);
        pageFill(targetTabId, title, prepared.linkedinBodyHtml, '', true, systemClipboardReady, debugEnabled).then(() => afterFill(targetTabId, prepared));
      });
      armShareFill(targetTabId);
    };

    chrome.tabs.onUpdated.addListener(listener);
    if (tab.status === 'complete') listener(targetTabId, { status: 'complete' });
  });
}
