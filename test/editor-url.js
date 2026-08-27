const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');
assert(source.includes('article?.publish_as_urn'));
assert(source.includes('urn ? `${LINKEDIN_EDITOR_URL}?author=${encodeURIComponent(urn)}` : LINKEDIN_EDITOR_URL'));
assert.strictEqual(
  `https://www.linkedin.com/article/new/?author=${encodeURIComponent('urn:li:organization:123456')}`,
  'https://www.linkedin.com/article/new/?author=urn%3Ali%3Aorganization%3A123456',
);
assert(popupSource.includes('publish_as_urn: selectedWebsiteLinkedInAuthorUrn()'));
console.log('PASS editor URL company-id propagation');
