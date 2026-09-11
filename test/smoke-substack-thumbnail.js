const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const start = source.indexOf('function cpFillSubstackThumbnail');
const end = source.indexOf('\n\nasync function substackCoverImage', start);
assert(start >= 0 && end > start, 'cpFillSubstackThumbnail not found');
const functionSource = source.slice(start, end).trim();

const html = `<!doctype html><html><body>
<div class="file-sidebar">
  <input placeholder="Add a title...">
  <textarea placeholder="Add a description..."></textarea>
  <input id="file-sidebar-file-input" type="file" accept="image/*">
</div>
<script>
  const sidebar = document.querySelector('.file-sidebar');
  const input = document.querySelector('#file-sidebar-file-input');
  input.addEventListener('input', () => {
    const image = document.createElement('img');
    image.src = 'blob:thumbnail';
    sidebar.appendChild(image);
  });
</script>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const result = await page.evaluate(
      async ({ functionSource }) => {
        const cpFillSubstackThumbnail = new Function(`${functionSource}; return cpFillSubstackThumbnail;`)();
        return cpFillSubstackThumbnail('iVBORw0KGgo=', 'image/png', 'Example title', 'Example SEO description');
      },
      { functionSource },
    );
    const values = await page.evaluate(() => ({
      title: document.querySelector('input[placeholder="Add a title..."]').value,
      description: document.querySelector('textarea[placeholder="Add a description..."]').value,
      fileName: document.querySelector('#file-sidebar-file-input').files[0]?.name || '',
      preview: !!document.querySelector('.file-sidebar img'),
    }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.method, 'thumbnail-file-input');
    assert.strictEqual(result.titleOk, true);
    assert.strictEqual(result.descriptionOk, true);
    assert.strictEqual(values.title, 'Example title');
    assert.strictEqual(values.description, 'Example SEO description');
    assert.strictEqual(values.fileName, 'contentpulse-thumbnail.png');
    assert.strictEqual(values.preview, true);
    console.log('PASS Substack thumbnail upload and SEO metadata flow');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('FAIL');
  console.error(error.message);
  process.exit(1);
});
