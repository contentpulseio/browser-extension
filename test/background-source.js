const fs = require('fs');
const path = require('path');

module.exports = function backgroundSource() {
  const extensionRoot = path.resolve(__dirname, '..');
  const entry = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  const imports = [...entry.matchAll(/"([^\"]+\.js)"/g)].map((match) => match[1]);
  if (!imports.length) throw new Error('No background scripts are imported by the service-worker entry point.');
  return imports
    .map((relativePath) => fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8'))
    .join('\n');
};
