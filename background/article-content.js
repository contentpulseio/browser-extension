// ContentPulse background: article content.
function extractHeroDescription(item) {
  const version = item?.current_version || {};
  const explicit = [item?.hero_description, version.hero_description].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (explicit) return explicit.trim();

  // API responses with structured-body access expose the hero as the first
  // section. Keep this extraction tolerant of both the current {type, data}
  // shape and the older {type, description} shape.
  const sections = Array.isArray(version.body)
    ? version.body
    : Array.isArray(item?.body)
      ? item.body
      : [];
  const hero = sections.find((section) => String(section?.type || section?.block || '').toLowerCase() === 'hero');
  if (!hero || typeof hero !== 'object') return '';
  const data = hero.data && typeof hero.data === 'object' ? hero.data : hero;
  return typeof data.description === 'string' ? data.description.trim() : '';
}

function normalizeArticle(item) {
  const version = item.current_version || {};
  const title = item.title || version.title || 'Untitled';
  const bodyHtml = version.rendered_html || '';
  const heroDescription = extractHeroDescription(item);
  const hero = (Array.isArray(version.body) ? version.body : Array.isArray(item.body) ? item.body : [])
    .find((section) => String(section?.type || section?.block || '').toLowerCase() === 'hero');
  const heroData = hero?.data && typeof hero.data === 'object' ? hero.data : hero;
  // Prefer explicit image attribution/caption. When absent, use the article
  // title as the hero caption rather than reusing the editorial description.
  const explicitImageCaption = [
    item.featured_image_credit,
    item.featured_image_caption,
    item.hero_caption,
    item.image_credit,
    item.credit,
    version.featured_image_credit,
    version.featured_image_caption,
    version.hero_caption,
    version.image_credit,
    version.credit,
    heroData?.image_credit,
    heroData?.credit,
    heroData?.caption,
  ].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
  const credit = explicitImageCaption || title;

  const scheduledDate = item.linkedin_scheduled_at || item.scheduled_at || null;
  const platform = normalizeExtensionPlatform(item.publish_channel || item.platform || '');
  const substackPublication = Array.isArray(item.publications)
    ? item.publications.find((publication) => String(publication?.platform || '').toLowerCase() === 'substack')
    : null;
  const substackDomain = [
    item.substack_domain,
    item.publish_options?.substack_domain,
    substackPublication?.remote_url,
    item.external_url,
    item.article_url,
    item.website?.substack_domain,
    item.website?.domain,
  ].map(normalizeSubstackDomain).find(Boolean) || '';

  const imageUrl = typeof version.featured_image_url === 'string' ? version.featured_image_url : null;

  const seo = {
    meta_title: typeof version.meta_title === 'string' ? version.meta_title : '',
    meta_description: typeof version.meta_description === 'string' ? version.meta_description : '',
    meta_keywords: Array.isArray(version.meta_keywords) ? version.meta_keywords : [],
    slug: typeof item.slug === 'string' ? item.slug : '',
  };

  // Prepared LinkedIn share copy (commentary + hashtags). LinkedIn forces a
  // share post when a Pulse article is published, so the popup offers this
  // text ready to paste into that dialog.
  const rawShare = item.linkedin_share_post;
  const sharePost =
    rawShare && typeof rawShare.commentary === 'string' && rawShare.commentary.trim() !== ''
      ? {
          commentary: rawShare.commentary,
          hashtags: typeof rawShare.hashtags === 'string' ? rawShare.hashtags : '',
        }
      : null;

  // Tags and categories from the API (used by Medium for "Reader Interests").
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => t.name || t).filter(Boolean) : [];
  const categories = Array.isArray(item.categories) ? item.categories.map((c) => c.name || c).filter(Boolean) : [];

  return {
    id: item.id,
    title,
    status: item.status || 'draft',
    platform,
    publish_channel: item.publish_channel || null,
    scheduled_date: scheduledDate,
    excerpt: typeof version.excerpt === 'string' ? version.excerpt : '',
    hero_description: heroDescription,
    credit,
    body_html: bodyHtml,
    image_url: imageUrl,
    external_url: typeof item.external_url === 'string' ? item.external_url : null,
    article_url: typeof item.article_url === 'string' ? item.article_url : null,
    share_post: sharePost,
    seo,
    tags,
    categories,
    substack_domain: substackDomain,
  };
}

function normalizeSubstackDomain(reference) {
  const value = String(reference || '').trim();
  if (!value) return '';

  // The API returns the publication slug for new articles before a remote
  // Substack URL exists.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return value.toLowerCase();

  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return '';
  }

  const host = String(url.hostname || '').toLowerCase();
  if (host === 'open.substack.com') {
    const match = url.pathname.match(/^\/pub\/([a-z0-9][a-z0-9-]*)\/p(?:\/|$)/i);
    return match ? match[1].toLowerCase() : '';
  }
  if (host === 'substack.com' || !host.endsWith('.substack.com')) return '';
  return host.replace(/\.substack\.com$/i, '');
}

// The article API puts charts, table renders, and other inline artwork inside
// rendered_html. LinkedIn cannot persist those remote <img src="..."> URLs in
// an article body; each image has to go through LinkedIn's own image uploader.
// Keep this parser DOM-free because it also runs in the extension service
// worker, where DOMParser is not available.
function findHeadingTextBefore(source, position) {
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let heading;
  let last = '';
  while ((heading = headingRe.exec(source))) {
    if (headingRe.lastIndex > position) break;
    last = String(heading[1] || '')
      .replace(/<br\s*\/?>(\s*)/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return last;
}

function extractInlineImagePlacements(html) {
  const source = typeof html === 'string' ? html : '';
  const images = [];
  const seen = new Set();

  const decode = (value) =>
    String(value || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();
  const text = (value) =>
    decode(String(value || '').replace(/<br\s*\/?>(\s*)/gi, ' ').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  const attr = (tag, name) => {
    const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return match ? decode(match[1]) : '';
  };
  const add = (tag, context, position) => {
    const url = attr(tag, 'src') || attr(tag, 'data-src');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    const anchorText = findHeadingTextBefore(source, position);
    const isChart = /(?:^|\/)charts?(?:\/|$|[?#])/i.test(url) || /\bchart\b/i.test(`${context?.className || ''} ${tag}`);
    const caption =
      text(context?.caption) ||
      attr(tag, 'data-caption') ||
      attr(tag, 'title') ||
      (isChart ? anchorText || attr(tag, 'alt') : attr(tag, 'alt') || anchorText);
    const alt = attr(tag, 'alt') || text(caption);
    seen.add(url);
    const placement = { url, caption: text(caption).slice(0, 250), alt: text(alt).slice(0, 500) };
    if (anchorText) placement.anchorText = anchorText;
    images.push(placement);
  };

  const figureRanges = [];
  const figureRe = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi;
  let figureMatch;
  while ((figureMatch = figureRe.exec(source))) {
    const inner = figureMatch[1] || '';
    const captionMatch = inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const context = { caption: captionMatch ? captionMatch[1] : '' };
    const imageRe = /<img\b[^>]*>/gi;
    let imageMatch;
    while ((imageMatch = imageRe.exec(inner))) add(imageMatch[0], context, figureMatch.index);
    figureRanges.push([figureMatch.index, figureRe.lastIndex]);
  }

  const imageRe = /<img\b[^>]*>/gi;
  let imageMatch;
  while ((imageMatch = imageRe.exec(source))) {
    if (!figureRanges.some(([start, end]) => imageMatch.index >= start && imageMatch.index < end)) {
      add(imageMatch[0], {}, imageMatch.index);
    }
  }
  return images;
}

function extractInlineImages(html) {
  return extractInlineImagePlacements(html).map(({ anchorText, ...image }) => image);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLinkedInHashtags(tags) {
  const values = Array.isArray(tags) ? tags : [];
  const seen = new Set();
  const hashtags = [];

  for (const value of values) {
    const raw = String(value?.name || value || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_]+/gu, '');
    if (!raw) continue;
    const key = raw.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(`#${raw}`);
  }

  return hashtags;
}

// The extension renderer can receive legacy tag markup where the tag names
// are concatenated after a final "Tags" heading. LinkedIn has no article tag
// field, so keep the section in the body but make every tag a separate,
// readable hashtag. This is intentionally LinkedIn-only; Medium uses the
// tags as Reader Interests and other platforms keep their own taxonomy.
function formatLinkedInTagsHtml(bodyHtml, tags) {
  const hashtags = normalizeLinkedInHashtags(tags);
  if (!hashtags.length) return bodyHtml || '';

  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  const tagBlock = `<h2>Tags</h2>\n<p>${escapeHtml(hashtags.join(' '))}</p>\n`;
  const headingPattern = /<h[1-6]\b[^>]*>\s*(?:<[^>]+>\s*)*Tags\s*(?:<\/[^>]+>\s*)*<\/h[1-6]>[\s\S]*$/i;
  if (headingPattern.test(source)) return source.replace(headingPattern, tagBlock);

  const paragraphPattern = /<p\b[^>]*>\s*(?:<strong\b[^>]*>\s*)?Tags\s*(?:<\/strong>\s*)?<\/p>[\s\S]*$/i;
  if (paragraphPattern.test(source)) return source.replace(paragraphPattern, tagBlock);

  return `${source}${source && !/\n$/.test(source) ? '\n' : ''}${tagBlock}`;
}

function addLinkedInTitleSpacing(bodyHtml) {
  // LinkedIn already provides the title/body separation. An empty paragraph
  // becomes a visible extra line and is not needed for caret placement.
  return typeof bodyHtml === 'string' ? bodyHtml : '';
}

function addLinkedInHeroDescription(bodyHtml, heroDescription) {
  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  const description = typeof heroDescription === 'string' ? heroDescription.trim() : '';
  if (!description) return source;

  const normalized = (value) => String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>(\s*)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  const heroText = normalized(description);
  if (!heroText || normalized(source).includes(heroText)) return source;

  return `<p>${escapeHtml(description)}</p>\n${source}`;
}

// Parse in the extension's isolated world. LinkedIn wraps DOMParser with its
// TrustedHTML sanitizer in the page's main world; parsing there silently
// flattens the formatted article into a single paragraph.
function parseLinkedInHtmlToDoc(html) {
  const parsed = new DOMParser().parseFromString(html || '', 'text/html');
  const content = [];
  const inline = (node) => {
    const result = [];
    const visit = (current, marks) => {
      if (current.nodeType === 3) {
        const text = (current.nodeValue || '').replace(/\s+/g, ' ');
        if (text.trim()) result.push(Object.assign({ type: 'text', text }, marks.length ? { marks: marks.slice() } : {}));
        else if (text === ' ' && result.length) result.push({ type: 'text', text: ' ' });
        return;
      }
      if (current.nodeType !== 1) return;
      const tag = current.tagName.toLowerCase();
      const nextMarks = marks.slice();
      if (tag === 'strong' || tag === 'b') nextMarks.push({ type: 'bold' });
      else if (tag === 'em' || tag === 'i') nextMarks.push({ type: 'italic' });
      else if (tag === 'code') nextMarks.push({ type: 'code' });
      else if (tag === 'a') {
        const href = current.getAttribute('href');
        if (href) nextMarks.push({ type: 'link', attrs: { href } });
      }
      if (tag !== 'br') Array.from(current.childNodes).forEach((child) => visit(child, nextMarks));
    };
    Array.from(node.childNodes).forEach((child) => visit(child, []));
    return result;
  };
  const paragraph = (element) => {
    const children = inline(element);
    return children.length ? { type: 'paragraph', content: children } : { type: 'paragraph' };
  };
  const pushBlock = (element) => {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = inline(element);
      content.push(Object.assign({ type: 'heading', attrs: { level: Number(tag[1]) } }, text.length ? { content: text } : {}));
    } else if (tag === 'p') {
      const children = inline(element);
      // Empty source paragraphs become visible blank lines in LinkedIn, most
      // noticeably after title spacing and around uploaded image blocks.
      if (children.length) content.push({ type: 'paragraph', content: children });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(element.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((item) => paragraph(item))
        .filter((item) => item.content?.length)
        .map((item) => ({ type: 'listItem', content: [item] }));
      if (items.length) content.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
    } else if (tag === 'blockquote') {
      const quoted = paragraph(element);
      if (quoted.content?.length) content.push({ type: 'blockquote', content: [quoted] });
    } else if (tag === 'pre') {
      content.push({ type: 'codeBlock', content: [{ type: 'text', text: element.textContent || '' }] });
    } else if (tag === 'hr') {
      content.push({ type: 'horizontalRule' });
    } else if (tag === 'figure' || tag === 'img') {
      // Inline images are uploaded through LinkedIn's native uploader after
      // the body is inserted. Do not leave a fake blank paragraph at the
      // source position; the uploader creates its own short-lived caret slot.
    } else if (tag === 'table') {
      const text = (element.textContent || '').trim();
      if (text) content.push({ type: 'paragraph', content: [{ type: 'text', text }] });
    } else {
      const children = Array.from(element.children);
      if (children.length) children.forEach(pushBlock);
      else {
        const text = inline(element);
        if (text.length) content.push({ type: 'paragraph', content: text });
      }
    }
  };
  Array.from(parsed.body.children).forEach(pushBlock);
  if (!content.length) {
    const text = (parsed.body.textContent || '').trim();
    if (text) content.push({ type: 'paragraph', content: [{ type: 'text', text }] });
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
