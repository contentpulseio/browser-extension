// ContentPulse background: media assets.
async function fetchImageAsBase64(imageUrl, requestHeaders = null) {
  const res = await fetch(imageUrl, requestHeaders ? { headers: requestHeaders } : undefined);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const blob = await res.blob();
  const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return { b64: btoa(binary), mime };
}

// Structured tables are intentionally exposed by a separate endpoint because
// they are rendered on demand as PNGs. Pull those PNGs through the same
// authenticated service-worker path used for charts so a platform never sees
// an unauthenticated table download URL.
async function fetchTableImages(contentId) {
  if (!contentId) return [];

  const { apiKey } = await getStored(['apiKey']);
  if (!apiKey) return [];

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  try {
    const listUrl = `${API_BASE}/content/${encodeURIComponent(contentId)}/tables`;
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) {
      warn('[ContentPulse][bg] table list failed', listRes.status);
      return [];
    }

    const payload = await listRes.json();
    const tables = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.data)
        ? payload.data.data
        : [];
    const assets = [];

    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index];
      const downloadUrl = typeof table?.download_url === 'string' ? table.download_url.trim() : '';
      if (!downloadUrl) continue;

      try {
        const { b64, mime } = await fetchImageAsBase64(downloadUrl, headers);
        const title = String(table.title || `Table ${index + 1}`).trim().slice(0, 250);
        assets.push({
          url: downloadUrl,
          b64,
          mime,
          caption: title,
          alt: `Table: ${title}`.slice(0, 500),
          table: true,
          sectionIndex: Number.isFinite(Number(table.section_index)) ? Number(table.section_index) : null,
        });
      } catch (error) {
        warn('[ContentPulse][bg] table image download failed', downloadUrl, error);
      }
    }

    log('[ContentPulse][bg] downloaded table images', assets.length);
    return assets;
  } catch (error) {
    warn('[ContentPulse][bg] table asset lookup failed', error);
    return [];
  }
}

function replaceTablesWithImageFigures(html, tableImages) {
  const source = typeof html === 'string' ? html : '';
  const assets = Array.isArray(tableImages) ? tableImages.filter((asset) => asset?.b64 && asset?.mime) : [];
  let index = 0;

  return source.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const asset = assets[index++];
    if (!asset) return tableHtml;
    const src = `data:${asset.mime};base64,${asset.b64}`;
    return `<figure data-contentpulse-table="true"><img src="${escapeHtml(src)}" alt="${escapeHtml(asset.alt || asset.caption || '')}"><figcaption>${escapeHtml(asset.caption || '')}</figcaption></figure>`;
  });
}

function buildSubstackHeroBody(bodyHtml, imageUrl, altText, captionText) {
  const source = typeof bodyHtml === 'string' ? bodyHtml : '';
  const url = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (!url || source.includes(url)) return source;
  const escape = (value) => String(value || '').slice(0, 500)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const caption = String(captionText || '').trim();
  const captionHtml = caption ? `<figcaption>${escape(caption)}</figcaption>` : '';
  const figure = `<figure><img src="${escape(url)}" alt="${escape(altText || 'Featured image')}">${captionHtml}</figure>`;
  return `${figure}${source}`;
}

// Medium's current editor has no native table block and flattens pasted table
// markup into ordinary text. Convert any available table renders first, then
// remove any table that could not be rendered so unsupported markup never
// reaches the editor.
function replaceTablesWithImageFiguresForMedium(html, tableImages) {
  const converted = replaceTablesWithImageFigures(html, tableImages);
  return converted.replace(/<table\b[\s\S]*?<\/table>/gi, '');
}

// LinkedIn has no table block type. Its body paste must not contain the
// original table markup because LinkedIn will flatten it into ordinary text
// before the dedicated uploader has a chance to place the generated PNG.
// Keep the table-image metadata from the original source and remove only the
// table markup from the body that is pasted into LinkedIn.
function removeTablesForLinkedIn(html) {
  const source = typeof html === 'string' ? html : '';
  return source.replace(/<table\b[\s\S]*?<\/table>/gi, '');
}

// Return metadata in the same order as the source body. This matters on
// Medium, where captions and alt text are applied to figures by position.
function buildInlineImageMeta(html, tableImages) {
  const source = typeof html === 'string' ? html : '';
  const assets = Array.isArray(tableImages) ? tableImages.filter(Boolean) : [];
  const remoteImages = extractInlineImagePlacements(source);
  const metadata = [];
  let remoteIndex = 0;
  let tableIndex = 0;
  const tokenRe = /<table\b[\s\S]*?<\/table>|<img\b[^>]*>/gi;
  let match;

  while ((match = tokenRe.exec(source))) {
    const token = match[0] || '';
    if (/^<table\b/i.test(token)) {
      if (assets[tableIndex]) {
        const anchorText = findHeadingTextBefore(source, match.index);
        const asset = assets[tableIndex];
        const caption = [asset.caption, asset.alt, anchorText]
          .find((value) => typeof value === 'string' && value.trim())?.trim() || '';
        metadata.push({
          ...asset,
          caption,
          alt: typeof asset.alt === 'string' && asset.alt.trim() ? asset.alt : caption,
          ...(anchorText ? { anchorText } : {}),
        });
      }
      tableIndex += 1;
      continue;
    }

    const candidate = remoteImages[remoteIndex++];
    if (candidate) metadata.push(candidate);
  }

  return metadata;
}

// Medium needs image bytes in its paste payload so its editor can ingest and
// upload them to Medium's own image storage. A remote <img src> can preview in
// the editor but is not a durable Medium upload. Resolve the bytes in the
// extension worker (where ContentPulse image-host permissions apply), then
// replace only each image's src before sending the paste event.
async function prepareMediumImagesForPaste(html, imageMeta) {
  const source = typeof html === 'string' ? html : '';
  const metadata = Array.isArray(imageMeta) ? imageMeta : [];
  const byUrl = new Map(metadata
    .filter((image) => image && typeof image.url === 'string' && image.url.trim())
    .map((image) => [image.url.trim(), image]));
  const preparedSources = new Map();
  const failures = [];

  const dataUriFor = async (url, item = {}) => {
    if (preparedSources.has(url)) return preparedSources.get(url);
    try {
      const imageData = item.b64 && item.mime
        ? { b64: item.b64, mime: item.mime }
        : await fetchImageAsBase64(url);
      const dataUri = `data:${imageData.mime};base64,${imageData.b64}`;
      preparedSources.set(url, dataUri);
      return dataUri;
    } catch (error) {
      failures.push({ url, message: error?.message || 'Image download failed' });
      return '';
    }
  };

  const decodeSrc = (value) => String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .trim();
  const imageTags = source.match(/<img\b[^>]*>/gi) || [];
  let preparedHtml = source;
  for (const tag of imageTags) {
    const srcMatch = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (!srcMatch) continue;
    const src = decodeSrc(srcMatch[2]);
    if (!/^https?:\/\//i.test(src)) continue;
    const dataUri = await dataUriFor(src, byUrl.get(src));
    if (dataUri) {
      const escapedSrc = srcMatch[2];
      preparedHtml = preparedHtml.replace(tag, tag.replace(escapedSrc, dataUri));
    }
  }

  if (failures.length) {
    return {
      ok: false,
      error: `Could not download ${failures.length} Medium image${failures.length === 1 ? '' : 's'} for upload.`,
      failures,
    };
  }

  return {
    ok: true,
    html: preparedHtml,
    imageMeta: metadata.map((item, index) => {
      const image = imageTags[index] || '';
      const srcMatch = image.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
      const source = decodeSrc(srcMatch?.[2] || '');
      const dataUri = /^data:image\//i.test(source)
        ? source
        : preparedSources.get(String(item?.url || source).trim()) || '';
      const dataMatch = dataUri.match(/^data:([^;,]+);base64,(.+)$/i);
      const suppliedBytes = item?.b64 && item?.mime
        ? { mime: item.mime, b64: item.b64 }
        : null;
      return {
        caption: item?.caption || '',
        alt: item?.alt || '',
        ...(suppliedBytes || (dataMatch ? { mime: dataMatch[1], b64: dataMatch[2] } : {})),
      };
    }),
    imageCount: imageTags.length,
  };
}

// Runs in the page (MAIN world). Drops the featured image into LinkedIn's
// cover-image file input (#media-editor-file-selector__file-input) via a
// DataTransfer so the editor treats it like a manual upload.
