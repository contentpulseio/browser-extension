const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const start = source.indexOf('function cpSubstackInsertHeroAtStart');
const end = source.indexOf('\n\nasync function substackInsertHeroAtStart', start);
assert(start >= 0 && end > start, 'cpSubstackInsertHeroAtStart not found');
const functionSource = source.slice(start, end).trim();

const imageUrl = 'https://contentpulse.io/storage/test-featured-image.webp';
const html = `<!doctype html><html><body>
<div class="tiptap ProseMirror mousetrap" data-testid="editor" contenteditable="true">
  <p>First paragraph</p>
</div>
<script>
  const editor = document.querySelector('[data-testid="editor"]');
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const tmp = document.createElement('div');
    tmp.innerHTML = event.clipboardData.getData('text/html');
    const figure = tmp.firstElementChild;
    setTimeout(() => editor.insertBefore(figure, editor.firstChild), 150);
  });
</script>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const result = await page.evaluate(
      async ({ functionSource, imageUrl }) => {
        const cpSubstackInsertHeroAtStart = new Function(`${functionSource}; return cpSubstackInsertHeroAtStart;`)();
        return cpSubstackInsertHeroAtStart(imageUrl, 'Featured alt', 'Featured caption');
      },
      { functionSource, imageUrl },
    );
    const values = await page.evaluate(() => ({
      firstTag: document.querySelector('[data-testid="editor"]')?.firstElementChild?.tagName,
      imageUrl: document.querySelector('[data-testid="editor"] img')?.src,
      alt: document.querySelector('[data-testid="editor"] img')?.alt,
      caption: document.querySelector('[data-testid="editor"] figcaption')?.textContent,
    }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(values.firstTag, 'FIGURE');
    assert.strictEqual(values.imageUrl, imageUrl);
    assert.strictEqual(values.alt, 'Featured alt');
    assert.strictEqual(values.caption, 'Featured caption');
    console.log('PASS Substack hero fallback inserts at editor start with caption');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('FAIL');
  console.error(error.message);
  process.exit(1);
});
