/**
 * Code Reader
 *
 * Maps error class names to actual source files in the AEM project.
 * Scans ALL modules: core, ui.apps, ui.frontend, ui.config, dispatcher.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { readdirSync, statSync } from 'fs';
import config from './config.js';

// Module → source paths mapping
const MODULE_PATHS = {
  core: ['core/src/main/java'],
  'ui.apps': ['ui.apps/src/main/content/jcr_root'],
  'ui.frontend': ['ui.frontend/src'],
  'ui.config': ['ui.config/src/main/content'],
  dispatcher: ['dispatcher/src'],
  'it.tests': ['it.tests/src'],
  'ui.tests': ['ui.tests/test-module/lib'],
};

/**
 * Find source file for a Java class name.
 * e.g., "com.aem.vue.core.filters.LoggingFilter" →
 *       "/path/to/core/src/main/java/com/aem/vue/core/filters/LoggingFilter.java"
 */
export function findJavaSource(className) {
  const projectDir = config.aem.projectDir;
  if (!projectDir || !existsSync(projectDir)) return null;

  // Convert class name to path: com.aem.vue.core.filters.LoggingFilter → com/aem/vue/core/filters/LoggingFilter.java
  const relativePath = className.replace(/\./g, '/') + '.java';

  // Search in core module first (most common)
  for (const basePath of MODULE_PATHS.core) {
    const fullPath = resolve(projectDir, basePath, relativePath);
    if (existsSync(fullPath)) return fullPath;
  }

  return null;
}

/**
 * Find HTL/component source for ui.apps errors.
 * Searches jcr_root for .html files matching the component path.
 */
export function findHTLSource(componentPath) {
  const projectDir = config.aem.projectDir;
  if (!projectDir) return null;

  const jcrRoot = resolve(projectDir, 'ui.apps/src/main/content/jcr_root');
  if (!existsSync(jcrRoot)) return null;

  // Try common patterns
  const candidates = [
    resolve(jcrRoot, componentPath, `${componentPath.split('/').pop()}.html`),
    resolve(jcrRoot, componentPath + '.html'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

/**
 * Find frontend source files (Vue, JS, SCSS).
 */
export function findFrontendSource(fileName) {
  const projectDir = config.aem.projectDir;
  if (!projectDir) return null;

  const srcDir = resolve(projectDir, 'ui.frontend/src');
  if (!existsSync(srcDir)) return null;

  // Recursive search for the file name
  return findFileRecursive(srcDir, fileName);
}

function findFileRecursive(dir, fileName, maxDepth = 5) {
  if (maxDepth <= 0) return null;

  try {
    const items = readdirSync(dir);
    for (const item of items) {
      if (item.startsWith('.') || item === 'node_modules') continue;
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isFile() && item === fileName) return fullPath;
      if (stat.isDirectory()) {
        const found = findFileRecursive(fullPath, fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* permission errors, etc. */ }

  return null;
}

/**
 * Read source file content with line numbers.
 * If stackTrace has line numbers, extract the relevant section.
 */
export function readSourceContext(filePath, lineNumber = null, contextLines = 15) {
  if (!filePath || !existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    if (lineNumber && lineNumber > 0) {
      // Extract context around the error line
      const start = Math.max(0, lineNumber - contextLines);
      const end = Math.min(lines.length, lineNumber + contextLines);
      const snippet = lines.slice(start, end)
        .map((line, i) => {
          const num = start + i + 1;
          const marker = num === lineNumber ? ' >>>' : '    ';
          return `${marker} ${num}: ${line}`;
        })
        .join('\n');

      return {
        filePath,
        lineNumber,
        totalLines: lines.length,
        snippet,
        language: getLanguage(filePath),
      };
    }

    // Return full file (truncated if too long)
    const maxLines = 100;
    const truncated = lines.length > maxLines;
    const snippet = lines.slice(0, maxLines)
      .map((line, i) => `    ${i + 1}: ${line}`)
      .join('\n');

    return {
      filePath,
      totalLines: lines.length,
      truncated,
      snippet: truncated ? snippet + `\n    ... (${lines.length - maxLines} more lines)` : snippet,
      language: getLanguage(filePath),
    };
  } catch (err) {
    return null;
  }
}

function getLanguage(filePath) {
  if (filePath.endsWith('.java')) return 'java';
  if (filePath.endsWith('.html')) return 'htl';
  if (filePath.endsWith('.vue')) return 'vue';
  if (filePath.endsWith('.js')) return 'javascript';
  if (filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.scss') || filePath.endsWith('.css')) return 'css';
  if (filePath.endsWith('.xml')) return 'xml';
  if (filePath.endsWith('.json')) return 'json';
  return 'text';
}

/**
 * Auto-detect source from a log entry.
 * Parses class name and stack trace to find the most relevant source file.
 */
export function findSourceForEntry(entry) {
  const className = entry.className || '';

  // Try Java source first
  const javaSource = findJavaSource(className);
  if (javaSource) {
    // Try to extract line number from stack trace
    let lineNumber = null;
    if (entry.stackTrace) {
      for (const line of entry.stackTrace) {
        // Match: at com.aem.vue.core.filters.LoggingFilter.doFilter(LoggingFilter.java:42)
        const match = line.match(/\((\w+\.java):(\d+)\)/);
        if (match && className.endsWith(match[1].replace('.java', ''))) {
          lineNumber = parseInt(match[2], 10);
          break;
        }
      }
    }
    return readSourceContext(javaSource, lineNumber);
  }

  // Try finding own code in stack trace
  if (entry.stackTrace) {
    for (const line of entry.stackTrace) {
      const match = line.match(/at (com\.aem\.vue\.\S+)\((\w+\.java):(\d+)\)/);
      if (match) {
        const src = findJavaSource(match[1]);
        if (src) return readSourceContext(src, parseInt(match[3], 10));
      }
    }
  }

  return null;
}
