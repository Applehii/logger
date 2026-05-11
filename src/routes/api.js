import { Router } from 'express';
import { analyzeEntry, buildPrompt } from '../ai-analyzer.js';
import { findSourceForEntry, findJavaSource, readSourceContext } from '../code-reader.js';

const router = Router();

// AI analysis endpoint
router.post('/analyze', async (req, res) => {
  const { entry } = req.body;
  if (!entry) return res.status(400).json({ error: 'entry is required' });

  try {
    const result = await analyzeEntry(entry);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build prompt for manual copy
router.post('/prompt', async (req, res) => {
  const { entry } = req.body;
  if (!entry) return res.status(400).json({ error: 'entry is required' });

  try {
    const { fullPrompt } = buildPrompt(entry);
    res.json({ prompt: fullPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find source code for an entry
router.post('/source', (req, res) => {
  const { entry } = req.body;
  if (!entry) return res.status(400).json({ error: 'entry is required' });

  const source = findSourceForEntry(entry);
  if (!source) return res.json({ found: false });
  res.json({ found: true, ...source });
});

// Look up a specific Java class
router.get('/source/:className', (req, res) => {
  const filePath = findJavaSource(req.params.className);
  if (!filePath) return res.json({ found: false });

  const context = readSourceContext(filePath);
  res.json({ found: true, ...context });
});

export default router;
