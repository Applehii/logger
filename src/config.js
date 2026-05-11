import { config as loadDotEnv } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

loadDotEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = resolve(__dirname, '../data/settings.json');

// Read saved settings
let savedSettings = {};
if (existsSync(SETTINGS_FILE)) {
  try {
    savedSettings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) {
    console.warn('[config] Failed to read settings.json', e.message);
  }
}

const getLogDir = () => savedSettings.aemLogDir || process.env.AEM_LOG_DIR || '';

const config = {
  aem: {
    host: savedSettings.aemHost || process.env.AEM_HOST || 'http://localhost:4502',
    user: process.env.AEM_USER || 'admin',
    pass: process.env.AEM_PASS || 'admin',
    get logDir() { return getLogDir(); },
    projectDir: process.env.AEM_PROJECT_DIR || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3333', 10),
  },
  ai: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  noiseFilter: process.env.NOISE_FILTER !== 'false',
  maxLogBuffer: parseInt(process.env.MAX_LOG_BUFFER || '5000', 10),

  get logFiles() {
    const files = {};
    const logDir = getLogDir();
    const customFilesString = savedSettings.logFilesRaw || process.env.AEM_LOG_FILES;
    
    if (customFilesString) {
      customFilesString.split(',').forEach(pair => {
        const [name, filename] = pair.split(':');
        if (name && filename) {
          files[name.trim()] = resolve(logDir, filename.trim());
        }
      });
    } else {
      // Default logs
      files.error = resolve(logDir, 'error.log');
      files.request = resolve(logDir, 'request.log');
      files.access = resolve(logDir, 'access.log');
    }
    return files;
  },

  // Metadata for the UI to show the raw values
  get raw() {
    return {
      aemHost: savedSettings.aemHost || process.env.AEM_HOST || 'http://localhost:4502',
      aemLogDir: getLogDir(),
      logFiles: savedSettings.logFilesRaw || process.env.AEM_LOG_FILES || 'error:error.log,request:request.log,access:access.log'
    };
  },

  updateConfig(newSettings) {
    savedSettings = { ...savedSettings, ...newSettings };
    // Maintain a raw string version for easier UI editing
    if (newSettings.logFiles) savedSettings.logFilesRaw = newSettings.logFiles;
    
    writeFileSync(SETTINGS_FILE, JSON.stringify(savedSettings, null, 2));
    
    // Update active config values that aren't getters
    this.aem.host = savedSettings.aemHost || this.aem.host;
  }
};

if (config.aem.logDir && !existsSync(config.aem.logDir)) {
  console.warn(`[config] AEM_LOG_DIR not found: ${config.aem.logDir}`);
}

export default config;
