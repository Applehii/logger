/**
 * AI Analyzer
 *
 * Uses DeepSeek API to analyze AEM error logs with source code context.
 */

import config from './config.js';
import { findSourceForEntry } from './code-reader.js';

const SYSTEM_PROMPT = `You are an expert AEM 6.5 developer and debugger. You specialize in:
- Adobe Experience Manager (AEM) 6.5
- Apache Sling, OSGi, JCR (Jackrabbit Oak)
- HTL (Sightly) templating
- Java servlets, Sling Models, OSGi services
- Vue.js frontend (ui.frontend module)
- AEM Dispatcher

When analyzing errors, provide:
1. **Root Cause** — What exactly caused this error
2. **Severity** — Critical / High / Medium / Low
3. **Impact** — What does this affect (page rendering, API, author UI, etc.)
4. **Fix** — Specific code changes with file path and line numbers
5. **Prevention** — How to prevent this in the future

Be concise and practical. Give actual code snippets for fixes, not vague advice.
If source code is provided, reference specific lines and methods.
Reply in Vietnamese.`;

export function buildPrompt(entry) {
  // Find relevant source code
  const sourceContext = findSourceForEntry(entry);

  // Build the prompt
  let userPrompt = `## Error Log Entry\n\`\`\`\n`;
  userPrompt += `Timestamp: ${entry.timestamp}\n`;
  userPrompt += `Level: ${entry.level}\n`;
  userPrompt += `Module: ${entry.module}\n`;
  userPrompt += `Class: ${entry.className}\n`;
  userPrompt += `Thread: ${entry.thread}\n`;
  userPrompt += `Message: ${entry.message}\n`;

  if (entry.stackTrace && entry.stackTrace.length > 0) {
    userPrompt += `\nStack Trace:\n${entry.stackTrace.join('\n')}\n`;
  }
  userPrompt += `\`\`\`\n`;

  if (sourceContext) {
    userPrompt += `\n## Relevant Source Code (${sourceContext.filePath})\n`;
    userPrompt += `Language: ${sourceContext.language}\n`;
    if (sourceContext.lineNumber) {
      userPrompt += `Error at line: ${sourceContext.lineNumber}\n`;
    }
    userPrompt += `\`\`\`${sourceContext.language}\n${sourceContext.snippet}\n\`\`\`\n`;
  }

  userPrompt += `\nAnalyze this error and provide root cause, severity, impact, specific fix, and prevention.`;

  return {
    fullPrompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`,
    sourceContext
  };
}

export async function analyzeEntry(entry) {
  if (!config.ai.apiKey) {
    return {
      error: 'DeepSeek API key not configured. Set DEEPSEEK_API_KEY in .env',
    };
  }

  const { fullPrompt, sourceContext } = buildPrompt(entry);
  const [systemPart, userPart] = fullPrompt.split('\n\n## Error Log Entry');
  const userPrompt = '## Error Log Entry' + userPart;

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  console.log(`[ai] Analyzing entry ${entry.id} with model ${config.ai.model} at ${baseUrl}...`);
  const startTime = Date.now();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(120000),
    });

    const duration = Date.now() - startTime;

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ai] API Error (${duration}ms): HTTP ${res.status} - ${errText}`);
      return { error: `DeepSeek API error: HTTP ${res.status} — ${errText.substring(0, 200)}` };
    }

    const data = await res.json();
    console.log(`[ai] Analysis complete (${duration}ms). Tokens: ${data.usage?.total_tokens}`);
    const content = data.choices?.[0]?.message?.content || 'No analysis returned';

    return {
      analysis: content,
      sourceContext: sourceContext ? {
        filePath: sourceContext.filePath,
        lineNumber: sourceContext.lineNumber,
        language: sourceContext.language,
      } : null,
      tokens: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
    };
  } catch (err) {
    return { error: `AI analysis failed: ${err.message}` };
  }
}

/**
 * AI Browser Agent: Plan actions based on DOM context and goal.
 */
export async function planBrowserActions(domContext, instruction) {
  if (!config.ai.apiKey) {
    return { error: 'API key not configured' };
  }

  const AGENT_SYSTEM_PROMPT = `You are an AI Browser Automation Agent.
Your goal is to provide a list of actions to perform on a web page to achieve the user's goal.
You will be provided with a simplified list of interactive DOM elements (inputs, buttons, links).

Rules:
1. Return ONLY a JSON array of actions.
2. Supported actions:
   - {"action": "type", "selector": "css-selector", "value": "text-to-type"}
   - {"action": "click", "selector": "css-selector"}
   - {"action": "wait", "ms": 2000}
3. Use specific selectors (ID is best, then class or name).
4. If the goal requires multiple steps (e.g., fill 3 fields and click), include all in order.
5. If the goal is not possible given the elements, return an empty array.

Output format example:
[
  {"action": "type", "selector": "#username", "value": "admin"},
  {"action": "type", "selector": "#password", "value": "password123"},
  {"action": "click", "selector": "button[type='submit']"}
]`;

  const userPrompt = `## Interactive Elements on Page:\n\`\`\`json\n${JSON.stringify(domContext, null, 2)}\n\`\`\`\n\n## User Goal:\n${instruction}\n\nPlan the actions to achieve this goal.`;

  try {
    const res = await fetch(`${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro', // Sử dụng bản Pro để AI suy luận tốt hơn cho Browser Agent
        messages: [
          { role: 'system', content: AGENT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1, // Thấp để đảm bảo tính chính xác
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI Agent Error: ${res.status} - ${text}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '[]';
    console.log(`[ai-agent] Raw response from AI: ${content.substring(0, 300)}...`);
    
    // Tìm mảng JSON [ ... ] trong chuỗi văn bản
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[ai-agent] No JSON array found in AI response');
      return [];
    }
    
    try {
      const actions = JSON.parse(jsonMatch[0]);
      console.log(`[ai-agent] Successfully parsed ${actions.length} actions.`);
      return actions;
    } catch (parseErr) {
      console.error('[ai-agent] JSON parse error:', parseErr.message);
      return [];
    }
  } catch (err) {
    console.error('[ai-agent] Planning failed:', err.message);
    return [];
  }
}
