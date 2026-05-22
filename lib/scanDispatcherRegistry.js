'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/**
 * Collect paths registered via internalDispatcher.register('...') in the repo.
 */
function collectRegisteredPaths() {
  const files = [
    path.join(ROOT, 'server.js'),
    ...walk(path.join(ROOT, 'services')).filter((f) => f.endsWith('registerRoutes.js')),
  ];
  const paths = new Set();
  const re = /internalDispatcher\.register\(\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) paths.add(m[1]);
  }
  return paths;
}

/**
 * Collect paths invoked via callInternal('...') in Inngest functions.
 */
function collectInngestInternalPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'services/inngest/functions.js'), 'utf8');
  return [...new Set([...src.matchAll(/callInternal\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
}

module.exports = { collectRegisteredPaths, collectInngestInternalPaths };
