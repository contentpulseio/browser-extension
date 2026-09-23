// ContentPulse background: message handlers.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('[ContentPulse][bg] message:', message?.action);

  switch (message?.action) {
    case 'validateKey':
      validateKey(message.apiKey).then(sendResponse);
      return true;

    case 'getWebsites':
      getWebsites().then(sendResponse);
      return true;

    case 'getArticles':
      getArticles(message.websiteId).then(sendResponse);
      return true;

    case 'getPopupState':
      getPopupState(message.websiteId).then(sendResponse);
      return true;

    case 'getArticle':
      getArticle(message.contentId).then(sendResponse);
      return true;

    case 'autoFillFromContentId':
      autoFillFromContentId(
        message.contentId,
        sender?.tab?.id,
        message.platform,
        (() => {
          try {
            return new URL(sender?.tab?.url || '').searchParams.get('cp_debug') === '1';
          } catch (e) {
            return false;
          }
        })(),
      )
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error?.message || 'The article could not be filled.' }));
      return true;

    case 'setScheduledAutoFill':
      setScheduledAutoFillEnabled(message.enabled).then(sendResponse);
      return true;

    case 'pageFill':

      pageFill(sender?.tab?.id, message.title, message.bodyHtml, message.bodyText).then(sendResponse);
      return true;

    case 'openAndFill':
      openAndFill(message.article)
        .then((result) => sendResponse(result || { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || 'The editor could not be opened.' }));
      return true;

    case 'clipboardPrepared':
      sendResponse(recordClipboardPrepared(message.token, message.prepared));
      return false;

    case 'fillSeo':
      fillSeoActive(message.seo).then(sendResponse);
      return true;

    case 'fillCoverImage':
      fillCoverImageActive(message.imageUrl, message.credit).then(sendResponse);
      return true;

    case 'fillSharePost':
      fillSharePostActive(composeShareText(message.sharePost)).then(sendResponse);
      return true;

    case 'schedulePost':
      schedulePostActive(message.scheduledAt).then(sendResponse);
      return true;

    case 'recordPublication':
      recordPublication(message.contentId, message.platform, message.remoteUrl).then(sendResponse);
      return true;

    case 'redditIngest':
      redditIngest(message.payload).then(sendResponse);
      return true;

    case 'markCommentSent':
      markCommentSent(message.oppId, message.commentUrl).then(sendResponse);
      return true;

    default:
      sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
      return false;
  }
});

// Keep the toolbar badge current even when the popup is closed. A short
// refresh interval is intentional: it catches schedule changes made in the
// ContentPulse dashboard without keeping a tab open or publishing anything.
