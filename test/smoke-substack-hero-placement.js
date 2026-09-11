const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const start = source.indexOf('function buildSubstackHeroBody');
const end = source.indexOf('\n\n// Medium\'s current editor', start);
assert(start >= 0 && end > start, 'buildSubstackHeroBody not found');
const functionSource = source.slice(start, end).trim();
const buildSubstackHeroBody = new Function(`${functionSource}; return buildSubstackHeroBody;`)();

const heroUrl = 'https://contentpulse.io/storage/hero.webp';
const body = '<figure><img src="https://contentpulse.io/storage/table.png" alt="Table"><figcaption>Table</figcaption></figure><p>Body</p>';
const result = buildSubstackHeroBody(body, heroUrl, 'Article title', 'Hero caption');

assert.match(result, /^<figure><img src="https:\/\/contentpulse\.io\/storage\/hero\.webp"/);
assert.match(result, /<figcaption>Hero caption<\/figcaption>/);
assert.ok(result.indexOf(heroUrl) < result.indexOf('table.png'), 'hero must be before existing body images');
assert.strictEqual(buildSubstackHeroBody(result, heroUrl, 'Article title', 'Hero caption'), result, 'hero must not duplicate');
console.log('PASS Substack hero is prepended before tables and remains idempotent');
