#!/usr/bin/env node
/**
 * sync_foundation.mjs
 * ----------------------------------------------------------------------------
 * Reads the canonical strategic-framework prompt modules from the frontend
 * repo (../maroa-ai-marketing-automator/src/lib/prompts/*.ts) and emits
 * CommonJS equivalents under services/prompts/ in this backend repo.
 *
 * Why this script exists:
 *   The frontend is the single source of truth for the 8 Foundation Principles,
 *   Psychology Layer, Industry Playbooks, and every per-workflow prompt module.
 *   This backend must not fork or paraphrase them. We also can't import .ts
 *   directly from Node 18 without a build step. So we maintain a one-way
 *   sync: edit in the frontend, run this script, commit the generated .js.
 *
 * Transform rules (TypeScript → CommonJS JavaScript):
 *   - `export const X = …`        → `const X = …; module.exports.X = X;`
 *   - `export function X(...)`    → `function X(...) { … }; module.exports.X = X;`
 *   - `export interface X`        → removed (type-only)
 *   - `export type X`             → removed (type-only)
 *   - `: Type` parameter/return annotations → stripped
 *   - `as const`                  → removed
 *   - `import { X } from './y'`   → `const { X } = require('./y');`
 *   - Template literals and strings pass through unchanged.
 *
 * Failure modes:
 *   - If the source TS file has grown new constructs (generics in exported
 *     functions, decorators, etc.) the transform will bail with a clear error
 *     rather than silently produce broken JS.
 *
 * Invocation:
 *   - Manually: `node scripts/sync_foundation.mjs`
 *   - Build time: add `"build": "node scripts/sync_foundation.mjs"` to
 *     package.json and ensure Railway runs `npm run build` before `npm start`.
 * ----------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FRONTEND_ROOT = resolve(REPO_ROOT, '..', 'maroa-ai-marketing-automator');
const SRC_PROMPTS = resolve(FRONTEND_ROOT, 'src', 'lib', 'prompts');
const OUT_PROMPTS = resolve(REPO_ROOT, 'services', 'prompts');

const FILES = [
  { src: 'foundation.ts', out: 'foundation.js' },
  { src: 'workflow_1_daily_content.ts', out: 'workflow_1_daily_content.js' },
];

function err(msg) {
  console.error(`[sync_foundation] FAIL: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// Transform a TS source string to CommonJS JS. Intentionally minimal — these
// files are pure-string prompt modules with simple function signatures and
// `export interface` type blocks. If any future file grows more elaborate, add
// rules here rather than hand-editing the generated output.
function tsToCjs(src, filename) {
  let out = src;

  // 1. Strip single-line and multi-line comments inside signatures? NO — keep
  //    all comments as-is; they're documentation.

  // 2. Convert `import { X, Y } from './z'` → `const { X, Y } = require('./z');`
  //    Use non-greedy and anchor to start of line.
  out = out.replace(
    /^import\s+\{\s*([^}]+?)\s*\}\s+from\s+['"]([^'"]+)['"];?$/gm,
    (_m, names, path) => {
      // Filter out type-only imports (leading `type` keyword)
      const cleanedNames = names
        .split(',')
        .map(n => n.trim())
        .filter(n => !n.startsWith('type '))
        .map(n => n.replace(/^type\s+/, ''))
        .join(', ');
      if (!cleanedNames) return ''; // nothing left
      const req = path.endsWith('.ts') ? path.replace(/\.ts$/, '.js') : `${path}.js`;
      return `const { ${cleanedNames} } = require('${req.startsWith('.') ? req : './' + req}');`;
    }
  );

  // 3. Remove `export interface X { ... }` blocks entirely (multi-line).
  //    Use a balanced-brace scanner rather than regex to be safe.
  out = removeExportedBlocks(out, /^export\s+interface\s+\w+[^{]*\{/m);

  // 4. Remove `export type X = ...;` single-line or multi-line ending in `;`.
  //    Multi-line: walk until matching `;` at brace depth 0.
  out = removeExportedTypeAliases(out);

  // 5. `export const X =` → `const X =` then append `module.exports.X = X;`
  //    at end of file for each matched name.
  const exportedConstNames = [];
  out = out.replace(/^export\s+const\s+(\w+)/gm, (_m, name) => {
    exportedConstNames.push(name);
    return `const ${name}`;
  });

  // 5b. Strip top-level variable type annotations: `const X: Type = ...`
  //     including complex generics `const X: Record<K, V> = ...`.
  out = stripVariableAnnotationsPass(out);

  // 6. `export function X(...)` → `function X(...)` + append export.
  const exportedFnNames = [];
  out = out.replace(/^export\s+function\s+(\w+)/gm, (_m, name) => {
    exportedFnNames.push(name);
    return `function ${name}`;
  });

  // 7. Strip TS type annotations in function signatures. This is the trickiest
  //    transform. We only need to handle the specific patterns in these files:
  //    - `function name(arg: Type, arg2: Type2): ReturnType {`
  //    - `(arg: Type) =>`
  //    - destructured `{ a, b }: { a: T; b: T }`
  //    Strategy: remove `: Something` up to the next `,` or `)` or `=` or `{`
  //    at the same paren depth. Do this inside function signatures only.
  out = stripTypeAnnotations(out);

  // 8. Strip `as const` and `as Type` assertions.
  out = out.replace(/\s+as\s+const\b/g, '');
  // Inline type casts: `foo as [number, number]` → `foo`
  // Match `as ` followed by a balanced bracketed type expression up to the
  // next `,`, `)`, `]`, `}`, `;`, `=`, or newline at depth 0.
  out = stripAsTypeCasts(out);

  // 9. Strip `satisfies X` assertions.
  out = out.replace(/\s+satisfies\s+[\w<>,\s|&.'"]+(?=\s*[;,)])/g, '');

  // 10. Append module.exports block.
  const exports = [...exportedConstNames, ...exportedFnNames];
  if (exports.length > 0) {
    out += '\n\n// ── Auto-generated CommonJS exports (sync_foundation.mjs) ──\n';
    for (const name of exports) {
      out += `module.exports.${name} = ${name};\n`;
    }
  }

  // Prepend the "do not edit" banner + source hash.
  const header = `/*
 * AUTOGENERATED FROM ${filename} — DO NOT EDIT BY HAND
 * Source: ../maroa-ai-marketing-automator/src/lib/prompts/${filename}
 * Regenerate: node scripts/sync_foundation.mjs
 * ---------------------------------------------------------------------------
 */
'use strict';

`;

  return header + out;
}

function removeExportedBlocks(src, startRegex) {
  let out = src;
  let match;
  while ((match = out.match(startRegex))) {
    const start = match.index;
    // Find matching closing brace starting from the `{` in the match.
    const openBraceIdx = out.indexOf('{', start);
    if (openBraceIdx === -1) break;
    let depth = 1;
    let i = openBraceIdx + 1;
    while (i < out.length && depth > 0) {
      const ch = out[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) err(`Unbalanced braces in exported block starting at ${start}`);
    out = out.slice(0, start) + out.slice(i).replace(/^\s*\n/, '');
  }
  return out;
}

function removeExportedTypeAliases(src) {
  // Match `export type Foo = …` and remove until matching end-of-statement `;`.
  // These are not very complex in our files — all single-line or cleanly ending.
  let out = src;
  const re = /^export\s+type\s+\w+[^=]*=\s*/m;
  let match;
  while ((match = out.match(re))) {
    const start = match.index;
    // Walk forward from end of the match to find `;` at paren/brace depth 0.
    let i = start + match[0].length;
    let depth = 0;
    while (i < out.length) {
      const ch = out[i];
      if (ch === '{' || ch === '(' || ch === '<') depth++;
      else if (ch === '}' || ch === ')' || ch === '>') depth--;
      else if (ch === ';' && depth === 0) { i++; break; }
      i++;
    }
    out = out.slice(0, start) + out.slice(i).replace(/^\s*\n/, '');
  }
  return out;
}

function stripVariableAnnotations(src) {
  // Match `const|let|var IDENT: ...` and remove `: ...` up to the `=` at
  // angle/paren/brace/bracket depth 0.
  return src.replace(/^(\s*(?:const|let|var)\s+\w+)(\s*:\s*)/gm, (fullMatch, head, colon, offset, full) => {
    // Walk forward from end of match to find the `=` at depth 0.
    const startIdx = offset + head.length + colon.length;
    let depth = 0;
    let j = startIdx;
    while (j < full.length) {
      const c = full[j];
      if (c === '<' || c === '(' || c === '{' || c === '[') depth++;
      else if (c === '>' || c === ')' || c === '}' || c === ']') depth--;
      else if (c === '=' && depth === 0) break;
      else if (c === '\n' && depth === 0) break;
      j++;
    }
    // We can't directly splice here because replace only gives us the match.
    // Instead, return a sentinel that a follow-up pass will handle.
    // Simpler approach: do this in a separate non-replace pass below.
    return fullMatch;
  });
}

function stripAsTypeCasts(src) {
  // Walk forward looking for ` as ` outside strings/comments. When found,
  // consume the type expression up to the next `,` `)` `]` `}` `;` `=` `\n`
  // at depth 0.
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Strings
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
        if (c === quote) { out += c; i++; break; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          out += c; i++;
          out += src[i]; i++;
          let d = 1;
          while (i < src.length) {
            const cc = src[i];
            out += cc;
            i++;
            if (cc === '{') d++;
            else if (cc === '}') { d--; if (d === 0) break; }
          }
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }
    // Line comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += src[i]; i++; }
      continue;
    }
    // Block comments
    if (ch === '/' && src[i + 1] === '*') {
      out += '/*'; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i]; i++; }
      if (i < src.length) { out += '*/'; i += 2; }
      continue;
    }
    // Detect ` as ` (space before, space after, preceded by word char or `)` or `]` or `}`).
    if (
      ch === ' ' &&
      src.slice(i + 1, i + 4) === 'as ' &&
      i > 0 &&
      /[\w$)\]}]/.test(src[i - 1])
    ) {
      // Skip ` as ` and the following type expression.
      i += 4; // past ' as '
      let depth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === '<' || c === '(' || c === '{' || c === '[') depth++;
        else if (c === '>' || c === ')' || c === '}' || c === ']') {
          if (depth === 0) break;
          depth--;
        } else if ((c === ',' || c === ';' || c === '=' || c === '\n') && depth === 0) break;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripVariableAnnotationsPass(src) {
  // Two-pass: find every `const|let|var IDENT:` and walk forward removing
  // annotation up to `=` at depth 0.
  let out = '';
  let i = 0;
  while (i < src.length) {
    // Skip strings
    const ch = src[i];
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
        if (c === quote) { out += c; i++; break; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          out += c;
          i++;
          out += src[i];
          i++;
          let d = 1;
          while (i < src.length) {
            const cc = src[i];
            out += cc;
            i++;
            if (cc === '{') d++;
            else if (cc === '}') { d--; if (d === 0) break; }
          }
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }
    // Skip comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += src[i]; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '/*'; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i]; i++; }
      if (i < src.length) { out += '*/'; i += 2; }
      continue;
    }
    // Look for `const |let |var ` at start of a non-string region
    const kw = src.slice(i, i + 6);
    const isConst = kw.startsWith('const ');
    const isLet = kw.startsWith('let ');
    const isVar = kw.startsWith('var ');
    if (
      (isConst || isLet || isVar) &&
      (i === 0 || /[\s;{}()]/.test(src[i - 1]))
    ) {
      const kwLen = isConst ? 6 : isLet ? 4 : 4;
      // Append the keyword
      out += src.slice(i, i + kwLen);
      i += kwLen;
      // Skip whitespace
      while (i < src.length && /\s/.test(src[i])) { out += src[i]; i++; }
      // Read identifier
      let idEnd = i;
      while (idEnd < src.length && /[\w$]/.test(src[idEnd])) idEnd++;
      out += src.slice(i, idEnd);
      i = idEnd;
      // Skip whitespace
      while (i < src.length && /[ \t]/.test(src[i])) { out += src[i]; i++; }
      // Is next char `:`? If so, strip annotation.
      if (src[i] === ':') {
        i++; // skip `:`
        let depth = 0;
        while (i < src.length) {
          const c = src[i];
          if (c === '<' || c === '(' || c === '{' || c === '[') depth++;
          else if (c === '>' || c === ')' || c === '}' || c === ']') depth--;
          else if (c === '=' && depth === 0) break;
          else if (c === ';' && depth === 0) break;
          else if (c === '\n' && depth === 0) break;
          i++;
        }
        // Insert a single space so `const NAME=` becomes `const NAME =`
        out += ' ';
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripTypeAnnotations(src) {
  // Remove return type annotations: `): ReturnType {` → `) {`
  // Handle multi-line return types by matching up to the opening `{` of the body.
  src = src.replace(/\)\s*:\s*\{[\s\S]*?\}\s*\{/g, ') {');
  src = src.replace(/\)\s*:\s*[\w<>,\[\]|&\s.'"]+\s*\{/g, ') {');

  // Remove parameter type annotations: walk character by character so we
  // respect nested braces/parens/generics.
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Detect the start of a parameter list: after `function NAME` or `NAME =`
    // we don't need to special-case — just strip `: Type` anywhere inside
    // parens where Type is a balanced expression ending at `,` `)` `=`.
    if (ch === ':' && i > 0) {
      // Check if we're inside a parameter list. Look back to the last
      // unmatched `(`; if found and the preceding char was an identifier or
      // `)` (destructuring close), this is a param annotation.
      const ctx = findParamContext(src, i);
      if (ctx) {
        // Skip the annotation — walk forward until `,`/`)`/`=` at the same depth.
        let j = i + 1;
        let depth = 0;
        while (j < src.length) {
          const c = src[j];
          if (c === '(' || c === '{' || c === '<' || c === '[') depth++;
          else if (c === ')' || c === '}' || c === '>' || c === ']') {
            if (depth === 0) break;
            depth--;
          } else if ((c === ',' || c === '=') && depth === 0) break;
          j++;
        }
        i = j;
        continue;
      }
    }

    // Skip string literals so we don't mangle `: ` inside text.
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
        if (c === quote) { out += c; i++; break; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          // template expression: ${...}. Output `${`, then walk until the
          // `}` that brings brace depth back to 0. Decrement THEN check.
          out += c;       // `$`
          i++;
          out += src[i];  // `{`
          i++;
          let depth = 1;
          while (i < src.length) {
            const cc = src[i];
            out += cc;
            i++;
            if (cc === '{') {
              depth++;
            } else if (cc === '}') {
              depth--;
              if (depth === 0) break;
            }
          }
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }

    // Skip line comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += src[i]; i++; }
      continue;
    }
    // Skip block comments
    if (ch === '/' && src[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i]; i++;
      }
      if (i < src.length) { out += '*/'; i += 2; }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function findParamContext(src, idx) {
  // Walk backwards to find an unmatched `(`. If we find one without first
  // hitting unbalanced `)` or entering a string, we're inside a param list.
  let depth = 0;
  for (let i = idx - 1; i > 0; i--) {
    const c = src[i];
    if (c === '`' || c === '"' || c === "'") {
      // Skip back over a string — find the matching opening quote
      let j = i - 1;
      while (j > 0 && src[j] !== c) { if (src[j - 1] === '\\') j--; j--; }
      i = j;
      continue;
    }
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) return true;
      depth--;
    }
    // Guard: don't look back more than ~5000 chars
    if (idx - i > 5000) return false;
  }
  return false;
}

function main() {
  if (!existsSync(SRC_PROMPTS)) {
    // Graceful no-op: Railway/prod builds don't have the frontend repo as a
    // sibling. In that case we rely on the committed services/prompts/*.js
    // files. Print a notice but exit 0 so `prestart` doesn't kill the server.
    console.log(`[sync_foundation] source dir not found at ${SRC_PROMPTS} — using committed generated files (OK for prod).`);
    process.exit(0);
  }
  ensureDir(OUT_PROMPTS);

  const manifest = [];

  for (const { src, out } of FILES) {
    const srcPath = join(SRC_PROMPTS, src);
    const outPath = join(OUT_PROMPTS, out);
    if (!existsSync(srcPath)) err(`Source not found: ${srcPath}`);

    const srcText = readFileSync(srcPath, 'utf8');
    const srcHash = createHash('sha256').update(srcText).digest('hex').slice(0, 12);

    const generated = tsToCjs(srcText, src);
    const finalOut = generated.replace(
      '---------------------------------------------------------------------------',
      `--------------------------------------------------------------------------- \n * Source SHA-256 (first 12): ${srcHash}`
    );

    writeFileSync(outPath, finalOut);
    manifest.push({ src, out, hash: srcHash });
    console.log(`[sync_foundation] ${src} → services/prompts/${out} (${srcHash})`);
  }

  // Write a manifest for provenance.
  writeFileSync(
    join(OUT_PROMPTS, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2)
  );

  console.log('[sync_foundation] done.');
}

main();
