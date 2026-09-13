const express = require('express');
const router = express.Router();
const pdfParse = require('pdf-parse');
const systemState = require('../systemState');
const { sendDiscordLog } = require('../discordLogger');
const db = require('../db');
const { checkMessageWithGroqModeration, getSafetyHotlineText } = require('../aiModeration');
const { JWT_SECRET } = require('../secrets');
const { emitSystemNotificationToOwners } = require('../chatSocket');

// GET /api/ai/status (Public AI Status Check)
router.get('/status', (req, res) => {
  res.json({
    enabled: systemState.isAiEnabled(),
    maintenance: !systemState.isAiEnabled()
  });
});


// Primary API: Google Gemini
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LTM28fLKtWdNnUeVryr0IoYv0fdvZRmeux61y-Bf1Enw';
const GEMINI_PRIMARY_MODEL = process.env.GEMINI_PRIMARY_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite';

// Fallback API: Groq (Centralized via server/secrets.js)
const { GROQ_API_KEY, GROQ_ENDPOINT, GROQ_TEXT_MODEL, GROQ_VISION_MODEL } = require('../secrets');

const BASE_SYSTEM_PROMPT = `You are Nitro AI — a super chill, high-IQ, and quick-witted study co-pilot. You combine the relaxed, casual personality of a clever friend with the pedagogical precision of an elite tutor. Speak naturally, informally, and lowkey use Gen Z slang and vibes (e.g., "no cap", "fr fr", "lowkey", "highkey", "bruh", "cooking", "it's giving", "slay", "bet", "real") where appropriate, but still keep it smart and actually helpful. Avoid sounding like a dry academic textbook or a stiff formal bot.

### Core Guidelines & Tone:
1. **Thorough, Helpful & Engaging (yet informal & Gen Z):** Never give a lazy, dismissive one-sentence answer. Provide thorough, step-by-step breakdowns and clear explanations in a friendly, conversational Gen Z peer-to-peer tone.
2. **Algebra & Math Handling:**
   - If the user provides an algebraic expression (e.g. "10x + 10"), explain how to factor it step-by-step ($10(x + 1)$), provide its roots if set to zero ($x = -1$), its slope-intercept form if graphed ($y = 10x + 10$), and clearly state the simplified result.
   - For word problems or equations, show every step: identify knowns, state formulas, isolate variables, and highlight the final boxed answer.
3. **Zero Meta-Commentary (STRICT):** NEVER break character. NEVER refer to yourself as an AI, bot, language model, or software program. NEVER ask the user if they are "testing" you or mention prompt limits.
4. **No Repetitive Greetings:** NEVER start responses with generic filler like "Hello! I am Nitro AI" or "As an AI...". Jump directly into the answer.
5. **Multimodal Vision & Documents:** When images or documents (PDFs, study guides, worksheets) are attached, analyze their contents directly. Extract the exact questions or diagrams and solve/explain them clearly.
6. **Formatting & Structure:**
   - Use clean Markdown with bold highlights, organized sections, bullet points, and code blocks.
   - For mathematical equations, format clean mathematical expressions (e.g. \`x = (-b ± √(b² - 4ac)) / 2a\` or \`$$...$$\`).

### Safety Protocols (Strict Enforcement):
- **Self-Harm / Crisis:** If the user indicates self-harm or suicide, override all tone and respond ONLY with:
  "Sorry, I can't help with that. Please know that you are not alone and help is available. You can reach the Suicide & Crisis Lifeline by calling or texting 988, or chatting at 988lifeline.org."
- **Malicious / Dangerous Activities:** If asked for weapons, dangerous chemicals, or illegal exploits, respond strictly with: "Sorry, I can't help with that."`;

const MODE_PROMPTS = {
  general: `[Active Mode: General Study Companion]\nBe balanced, quick-witted, helpful, and adaptable across all academic subjects and casual conversation.`,
  math: `[Active Mode: STEM & Advanced Math Solver]\nAct as an elite mathematics and physics tutor.
1. Identify given values and target variables clearly.
2. State the relevant formulas, laws, or theorems.
3. Walk through each algebraic and numerical step with precision.
4. Highlight the final answer clearly with bold/boxed formatting.
5. Provide an intuitive sanity-check or alternative method if applicable.`,
  code: `[Active Mode: Senior Software Engineer & Coding Mentor]\nAct as an expert software architect and programmer.
1. Provide clean, well-commented, modern, and production-ready code.
2. Explain the core algorithmic logic and why this solution is optimal.
3. Highlight edge cases, performance considerations (Time & Space complexity), and best practices.
4. If debugging code, clearly point out the bug, explain why it broke, and provide the clean fix.`,
  writing: `[Active Mode: Essay Editor & Humanities Coach]\nAct as a master writing consultant and literature scholar.
1. Analyze essay prompts, thesis statements, rhetoric, and argumentation structure.
2. Suggest vocabulary improvements, sentence flow variations, and stronger transitional phrasing.
3. Provide constructive feedback on grammar, punctuation, and clarity without writing generic filler.
4. Help brainstorm compelling outlines and counter-arguments.`,
  science: `[Active Mode: Science & STEM Explainer]\nAct as an engaging science educator (Biology, Chemistry, Physics, Environmental Science).
1. Explain complex scientific mechanisms using intuitive real-world analogies.
2. Break down cause-and-effect processes step-by-step (e.g., cellular respiration, chemical equilibria, orbital mechanics).
3. Connect theoretical concepts to practical, observable phenomena.`
};

// Global In-Memory Rate Limiter with Dynamic Threshold
// Capped to prevent unbounded array growth; uses a circular-friendly splice approach
const requestTimestamps = [];
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_RATE_LIMIT_ENTRIES = 200; // hard cap — well above any realistic rateLimit value

function checkGlobalRateLimit(maxRequests = 15) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  // Remove expired entries from the front
  let i = 0;
  while (i < requestTimestamps.length && requestTimestamps[i] <= cutoff) i++;
  if (i > 0) requestTimestamps.splice(0, i);
  // Hard cap in case of extreme backlog
  if (requestTimestamps.length > MAX_RATE_LIMIT_ENTRIES) {
    requestTimestamps.splice(0, requestTimestamps.length - MAX_RATE_LIMIT_ENTRIES);
  }
  if (requestTimestamps.length >= maxRequests) {
    return false;
  }
  requestTimestamps.push(now);
  return true;
}

function getLocalFallbackAnswer(message) {
  const query = (message || '').toLowerCase();
  
  if (query.includes('suicide') || query.includes('self-harm') || query.includes('kill my') || query.includes('end my life')) {
    return "Sorry, I can't help with that. Please know that you are not alone and help is available. You can reach the Suicide & Crisis Lifeline by calling or texting 988, or chatting at 988lifeline.org.";
  }
  if (query.includes('illegal') || query.includes('hack') || query.includes('weapon') || query.includes('bomb')) {
    return "Sorry, I can't help with that.";
  }

  const cleanMath = message.replace(/\?/g, '').trim();
  if (/^[\d\s\+\-\*\/\^\.\(\)]+$/.test(cleanMath) && /\d/.test(cleanMath) && /[\+\-\*\/\^]/.test(cleanMath)) {
    try {
      const expr = cleanMath.replace(/\^/g, '**');
      const ans = Function(`"use strict"; return (${expr})`)();
      if (typeof ans === 'number' && !isNaN(ans) && isFinite(ans)) {
        return `📐 **Math Solution:**\n\n$$${cleanMath} = ${ans}$$\n\nThe answer is **${ans}**.`;
      }
    } catch (e) {}
  }

  return null;
}

async function extractTextFromDocument(fileBase64, fileName, fileType) {
  if (!fileBase64) return null;
  
  let rawBase64 = fileBase64;
  if (fileBase64.includes(';base64,')) {
    rawBase64 = fileBase64.split(';base64,')[1];
  }

  const buffer = Buffer.from(rawBase64, 'base64');
  const lowerName = (fileName || '').toLowerCase();
  const lowerType = (fileType || '').toLowerCase();

  // Parse PDF documents
  if (lowerType.includes('pdf') || lowerName.endsWith('.pdf')) {
    try {
      if (typeof pdfParse === 'function') {
        const pdfData = await pdfParse(buffer);
        if (pdfData && pdfData.text && pdfData.text.trim()) {
          return pdfData.text.trim();
        }
      } else if (pdfParse && typeof pdfParse.PDFParse === 'function') {
        const parser = new pdfParse.PDFParse({ data: buffer });
        const res = await parser.getText();
        if (res && res.text && res.text.trim()) {
          return res.text.trim();
        }
      }
    } catch (e) {
      console.warn('PDF parsing attempt error:', e.message);
    }
  }

  // Parse Text documents (.txt, .docx, .md, etc.)
  try {
    const utf8Text = buffer.toString('utf-8');
    const cleanChars = utf8Text.replace(/[^\x20-\x7E\n\r\t]/g, '');
    if (cleanChars && cleanChars.trim().length > 20) {
      return cleanChars.trim();
    }
  } catch (e) {}

  return null;
}



async function callGroq(messages, hasImage = false, customModel = null, temperature = 0.7) {
  try {
    const targetModel = hasImage ? GROQ_VISION_MODEL : (customModel || GROQ_TEXT_MODEL);

    let res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages,
        temperature
      })
    });

    if (!res.ok) {
      res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_TEXT_MODEL,
          temperature,
          messages: messages.map(m => {
            if (Array.isArray(m.content)) {
              const textPart = m.content.find(p => p.type === 'text');
              return { ...m, content: textPart ? textPart.text : 'Analyze document' };
            }
            return m;
          })
        })
      });
    }

    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || null;
    }
  } catch (e) {
    console.warn('Groq API attempt failed:', e.message);
  }
  return null;
}

// POST /api/ai/ask
router.post('/ask', async (req, res) => {
  const currentAiConfig = systemState.getAiConfig();

  // 1. Emergency Kill Switch or Chat Disabled Check
  if (!systemState.isAiEnabled() || currentAiConfig.chatEnabled === false || currentAiConfig.enableEmergencyAiKillSwitch) {
    return res.status(503).json({
      error: "🛠️ Nitro AI is currently offline for scheduled maintenance or emergency safety mode. Please check back soon!",
      maintenance: true
    });
  }

  // 2. Global Dynamic Rate Limit
  const rateLimit = currentAiConfig.globalChatRateLimitPerMin || currentAiConfig.chatRateLimit || 30;
  if (!checkGlobalRateLimit(rateLimit)) {
    return res.status(429).json({
      error: `⚠️ Nitro AI is currently at maximum capacity (${rateLimit} requests/min). Please wait a moment and try again!`
    });
  }

  let { message, userPrompt, imageBase64, fileBase64, fileName, fileType, history, mode } = req.body;
  let textQuery = (userPrompt || message || '').trim();

  // 3. Max Prompt Length Enforcement
  const maxLen = currentAiConfig.maxPromptLength || 4000;
  if (textQuery.length > maxLen) {
    textQuery = textQuery.slice(0, maxLen);
  }

  // 4. Anti-Prompt Injection Filter
  if (currentAiConfig.enableAntiPromptInjection && textQuery) {
    const lower = textQuery.toLowerCase();
    if (lower.includes('ignore previous instructions') || lower.includes('disregard all previous') || lower.includes('jailbreak') || lower.includes('developer mode')) {
      textQuery = textQuery.replace(/ignore\s+previous\s+instructions/gi, '[filtered]').replace(/disregard\s+all\s+previous/gi, '[filtered]');
    }
  }

  // 4b. AI Chat safety moderation check
  if (textQuery) {
    try {
      const aiCheck = await checkMessageWithGroqModeration(textQuery);
      if (aiCheck && aiCheck.flagged) {
        const username = req.user ? req.user.username : (req.body.guestNickname || 'Anonymous');
        const display_name = req.user ? (req.user.display_name || req.user.username) : (req.body.guestNickname || 'Guest');
        const targetId = req.user ? req.user.id : null;
        
        await db.logAiModerationViolation({
          userId: targetId,
          username,
          message: textQuery,
          category: aiCheck.category,
          severity: aiCheck.severity,
          confidence: aiCheck.confidence,
          action_taken: 'ai_chat_blocked',
          reason: `AI Chatbot Prompt Flagged: ${aiCheck.reason}`
        });
        
        sendDiscordLog({
          category: 'moderation',
          action: 'AI_CHATBOT_PROMPT_FLAGGED',
          admin: 'AI_SAFETY_ENGINE',
          target: `@${username}`,
          details: `AI Chatbot prompt flagged: "${textQuery}" | Category: ${aiCheck.category} | Reason: ${aiCheck.reason}`
        });
        
        const io = req.app.get('io');
        if (io) {
          emitSystemNotificationToOwners(io, {
            title: `🚨 AI Chatbot Prompt Flagged`,
            message: `@${username} (${display_name}) was flagged in AI Chatbot for ${aiCheck.category.toUpperCase()}: "${textQuery}"`,
            level: 'error'
          });
        }
        
        const hotlineMsg = getSafetyHotlineText(aiCheck.category, aiCheck.reason, textQuery);
        if (hotlineMsg) {
          return res.status(400).json({
            error: `Sorry, I can't help with that. ${hotlineMsg}`
          });
        }
        
        return res.status(400).json({
          error: `🛡️ [Groq AI Safety] Your message was flagged: ${aiCheck.reason} (${aiCheck.category}). Please keep chat safe and clean.`
        });
      }
    } catch (e) {
      console.error('AI chat safety check error:', e);
    }
  }

  const attachmentBase64 = fileBase64 || imageBase64;
  const activeModeKey = (mode && MODE_PROMPTS[mode]) ? mode : 'general';

  // 5. Subject Specific Prompt Construction
  const subjectPromptMap = {
    general: currentAiConfig.generalSystemPrompt || BASE_SYSTEM_PROMPT,
    math: currentAiConfig.mathSystemPrompt || MODE_PROMPTS.math,
    code: currentAiConfig.codeSystemPrompt || MODE_PROMPTS.code,
    writing: currentAiConfig.writingSystemPrompt || MODE_PROMPTS.writing,
    science: currentAiConfig.scienceSystemPrompt || MODE_PROMPTS.science
  };

  let effectiveSystemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${MODE_PROMPTS[activeModeKey]}`;

  // Persona Tone Directives
  const personality = currentAiConfig.chatPersonality || 'friendly';
  if (personality === 'professor') {
    effectiveSystemPrompt += '\n\n[Tone Directive: Adopt a rigorous, scholarly, and formal academic professor persona.]';
  } else if (personality === 'socratic') {
    effectiveSystemPrompt += '\n\n[Tone Directive: Practice the Socratic method. Guide the student with leading questions and hints before giving the final answer.]';
  } else if (personality === 'concise') {
    effectiveSystemPrompt += '\n\n[Tone Directive: Be extremely concise, direct, and utilize structured bullet points without fluff.]';
  } else {
    effectiveSystemPrompt += '\n\n[Tone Directive: Adopt a super chill, informal, peer-like tone. Write using Gen Z slang, abbreviations, and expressions naturally (e.g. "fr fr", "no cap", "bruh", "lowkey", "cooking", "it\'s giving"). Keep it highly engaging, clever, and relaxed, like a smart classmate texting a close friend.]';
  }

  if (currentAiConfig.chatCustomDirectives) {
    effectiveSystemPrompt += `\n\n### Platform Custom Instructions & Directives:\n${currentAiConfig.chatCustomDirectives}`;
  }

  if (!textQuery && !attachmentBase64) {
    return res.status(400).json({ error: 'Message, image, or document file is required.' });
  }

  // 7. Local Math Pre-Computation (0ms latency solver)
  if (currentAiConfig.enableLocalMathSolver !== false) {
    const localCheck = getLocalFallbackAnswer(textQuery);
    if (localCheck && !attachmentBase64) {
      return res.json({ answer: localCheck, success: true });
    }
  }

  const messages = [
    { role: 'system', content: effectiveSystemPrompt }
  ];

  const maxHistoryTurns = currentAiConfig.contextWindowSize || 8;
  if (Array.isArray(history) && history.length > 0) {
    history.slice(-maxHistoryTurns).forEach(h => {
      if (h && h.role && h.content) {
        messages.push({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: String(h.content)
        });
      }
    });
  }

  const isImage = (fileType && fileType.startsWith('image/')) || (!fileType && imageBase64);

  let userContent = textQuery || 'Analyze attached content.';

  if (attachmentBase64) {
    if (isImage) {
      const formattedUrl = attachmentBase64.startsWith('data:')
        ? attachmentBase64
        : `data:image/jpeg;base64,${attachmentBase64}`;

      userContent = [
        { type: 'text', text: textQuery || 'Analyze this image in detail.' },
        { type: 'image_url', image_url: { url: formattedUrl } }
      ];
    } else {
      // Document file (.pdf, .txt, .docx, .md)
      const maxPdfChars = currentAiConfig.pdfMaxExtractedChars || 20000;
      let extractedText = await extractTextFromDocument(attachmentBase64, fileName, fileType);
      if (extractedText && extractedText.length > maxPdfChars) {
        extractedText = extractedText.slice(0, maxPdfChars);
      }
      const nameHeader = fileName ? `[Attached Document: ${fileName}]` : '[Attached Document]';
      
      if (extractedText) {
        userContent = `${textQuery ? textQuery + '\n\n' : ''}${nameHeader}\n${extractedText}`;
      } else {
        userContent = `${textQuery ? textQuery + '\n\n' : ''}${nameHeader}\n(Document attached: ${fileName || 'file.pdf'})`;
      }
    }
  }

  messages.push({ role: 'user', content: userContent });

  // 8. Dynamic Model & Hyperparameter Selection
  const preferredModel = (isImage ? currentAiConfig.visionModel : currentAiConfig.primaryChatModel) || currentAiConfig.chatModel || GROQ_TEXT_MODEL;
  const targetModel = preferredModel.startsWith('gemini') ? GROQ_TEXT_MODEL : preferredModel;
  
  // Subject temperature selection
  let temperature = currentAiConfig.chatTemperature !== undefined ? currentAiConfig.chatTemperature : 0.7;
  if (activeModeKey === 'math' && currentAiConfig.mathTemperature !== undefined) temperature = currentAiConfig.mathTemperature;
  if (activeModeKey === 'code' && currentAiConfig.codeTemperature !== undefined) temperature = currentAiConfig.codeTemperature;
  if (activeModeKey === 'writing' && currentAiConfig.writingTemperature !== undefined) temperature = currentAiConfig.writingTemperature;

  const answer = await callGroq(messages, isImage, targetModel, temperature);

  // 9. If answer received from either service
  if (answer) {
    try {
      const username = (req.session && req.session.user && req.session.user.username) || req.body.username || 'Guest';
      sendDiscordLog({
        category: 'ai_chat',
        action: 'AI_CHAT_CONVERSATION',
        admin: username,
        target: `Mode: ${(activeModeKey || 'general').toUpperCase()}`,
        details: `**User Question:** ${textQuery || '(Document/Image Attachment)'}\n\n**Nitro AI Response:**\n${answer.length > 1400 ? answer.slice(0, 1400) + '...' : answer}`
      });
    } catch (e) {}

    // Update quest progress for AI Chat if user is authenticated
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.id) {
          await db.updateQuestProgress(decoded.id, 'ai_chat');
        }
      }
    } catch (e) {}

    return res.json({ answer, success: true });
  }

  // 10. Fallback mock if enabled
  if (currentAiConfig.enableOfflineFallbackMock) {
    return res.json({
      answer: "💡 **Study Tip:** Keep organized notes and break big problems down into step-by-step components! (Nitro AI is temporarily buffering connections).",
      success: true
    });
  }

  return res.status(503).json({
    error: "⚠️ Nitro AI is currently busy. Please wait a few moments and try again!"
  });
});

// AI Flashcards Generator API
router.post('/flashcards', async (req, res) => {
  if (!systemState.isAiEnabled()) {
    return res.status(503).json({
      error: "🛠️ Nitro AI Flashcard Studio is currently offline for maintenance. Please check back soon!",
      maintenance: true
    });
  }

  const currentAiConfig = systemState.getAiConfig();
  const rateLimit = currentAiConfig.chatRateLimit || 30;

  if (!checkGlobalRateLimit(rateLimit)) {
    return res.status(429).json({
      error: `⚠️ Nitro AI is at maximum capacity (${rateLimit} req/min). Please try again in a few seconds.`
    });
  }

  const { topic, notes, fileBase64, fileName, fileType, count = 8 } = req.body;
  let sourceContent = (topic || notes || '').trim();

  if (fileBase64) {
    const docText = await extractTextFromDocument(fileBase64, fileName, fileType);
    if (docText) {
      sourceContent = `${sourceContent ? sourceContent + '\n\n' : ''}[Document: ${fileName || 'Notes'}]\n${docText}`;
    }
  }

  if (!sourceContent) {
    return res.status(400).json({ error: 'Please provide a topic, notes text, or upload a document.' });
  }

  const prompt = `Generate an interactive study flashcard deck of ${count} cards based on the following material:
"""
${sourceContent.slice(0, 4000)}
"""

You MUST respond strictly with valid JSON conforming to this exact structure and NOTHING else:
{
  "title": "Clear Topic or Subject Title",
  "category": "Math / Science / History / CS / General",
  "cards": [
    {
      "front": "Term, Concept, or Question",
      "back": "Clear, concise definition, proof, or answer",
      "hint": "Brief memory clue or key tip"
    }
  ]
}`;

  const messages = [
    { role: 'system', content: 'You are an expert curriculum educator. Output only raw JSON.' },
    { role: 'user', content: prompt }
  ];

  const preferredModel = currentAiConfig.chatModel || GROQ_TEXT_MODEL;
  const targetModel = preferredModel.startsWith('gemini') ? GROQ_TEXT_MODEL : preferredModel;
  const temperature = currentAiConfig.chatTemperature !== undefined ? currentAiConfig.chatTemperature : 0.7;

  const raw = await callGroq(messages, false, targetModel, temperature);

  if (!raw) {
    return res.status(503).json({ error: 'AI deck generator is currently unavailable. Please try again.' });
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid JSON format returned.');
    const deck = JSON.parse(jsonMatch[0]);
    return res.json({ success: true, deck });
  } catch (err) {
    console.error('Flashcard JSON parse error:', err.message, raw);
    return res.status(500).json({ error: 'Failed to parse flashcard deck JSON. Please try again.' });
  }
});

// POST /api/ai/generate-image - AI Image Generator via Pollinations.ai
router.post('/generate-image', async (req, res) => {
  if (!systemState.isAiEnabled()) {
    return res.status(503).json({
      error: '⚠️ Nitro AI is currently under maintenance. Please try again later.',
      maintenance: true
    });
  }

  const { prompt, width, height, enhance } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  try {
    const cleanPrompt = encodeURIComponent(prompt.trim());
    const w = parseInt(width, 10) || 512;
    const h = parseInt(height, 10) || 512;
    const isEnhanced = enhance !== false;

    const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=${w}&height=${h}&nologo=true&private=true${isEnhanced ? '&enhance=true' : ''}`;

    res.json({
      success: true,
      imageUrl: imageUrl
    });
  } catch (err) {
    console.error('Image generation error:', err);
    res.status(500).json({ error: 'Failed to generate image. Please try again.' });
  }
});

// POST /api/ai/proofread - AI Essay Proofreader & Grammar Enhancer
router.post('/proofread', async (req, res) => {
  if (!systemState.isAiEnabled()) {
    return res.status(503).json({ error: 'Nitro AI is currently under maintenance.', maintenance: true });
  }

  const { text, tone } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Essay text is required.' });
  }

  const targetTone = tone || 'Academic';
  const prompt = `You are a world-class academic editor and writing consultant. Analyze the following text for grammar, punctuation, vocabulary, and tone adherence (${targetTone}).
Output ONLY raw valid JSON matching this schema:
{
  "originalText": string,
  "correctedText": string,
  "enhancedText": string,
  "toneScore": number (0-100),
  "corrections": [
    { "type": "Grammar" | "Spelling" | "Vocabulary" | "Tone", "original": string, "suggestion": string, "explanation": string }
  ]
}

Text to proofread:
"""
${text.trim().substring(0, 4000)}
"""`;

  try {
    const messages = [
      { role: 'system', content: 'You are an expert essay proofreader. Output only raw JSON.' },
      { role: 'user', content: prompt }
    ];
    const raw = await callGroq(messages, false, GROQ_TEXT_MODEL, 0.3);
    if (!raw) return res.status(503).json({ error: 'Proofreading service unavailable.' });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid JSON format');
    const result = JSON.parse(jsonMatch[0]);

    res.json({ success: true, result });
  } catch (err) {
    console.error('Proofread error:', err);
    res.status(500).json({ error: 'Failed to proofread text.' });
  }
});

// POST /api/ai/humanize - AI Text Humanizer
router.post('/humanize', async (req, res) => {
  if (!systemState.isAiEnabled()) {
    return res.status(503).json({ error: 'Nitro AI is currently under maintenance.', maintenance: true });
  }

  const { text, intensity } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text to humanize is required.' });
  }

  const prompt = `You are an expert writing coach specializing in naturalizing AI-generated content into human writing.
Rewrite the following text so it reads 100% like authentic human writing.
Guidelines:
- Vary sentence length and structure (burstiness).
- Eliminate robotic transitions (e.g. "Furthermore", "In conclusion", "It is important to note").
- Use active, engaging verbs and natural phrasing.
- Preserve the exact meaning and key facts.

Text to humanize:
"""
${text.trim().substring(0, 4000)}
"""`;

  try {
    const messages = [
      { role: 'system', content: 'You rewrite AI text into natural human prose.' },
      { role: 'user', content: prompt }
    ];
    const humanized = await callGroq(messages, false, GROQ_TEXT_MODEL, 0.7);
    if (!humanized) return res.status(503).json({ error: 'Humanizer service unavailable.' });

    res.json({ success: true, humanizedText: humanized.trim() });
  } catch (err) {
    console.error('Humanize error:', err);
    res.status(500).json({ error: 'Failed to humanize text.' });
  }
});

// POST /api/ai/plagiarism-check - AI Plagiarism & Originality Scanner
router.post('/plagiarism-check', async (req, res) => {
  if (!systemState.isAiEnabled()) {
    return res.status(503).json({ error: 'Nitro AI is currently under maintenance.', maintenance: true });
  }

  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text for originality scan is required.' });
  }

  const prompt = `Analyze the following text for plagiarism, generic AI-generated clichés, and originality metrics.
Output ONLY raw valid JSON matching this schema:
{
  "originalityScore": number (0-100),
  "aiDetectionScore": number (0-100),
  "status": "High Originality" | "Moderate AI Risk" | "High Plagiarism Risk",
  "flaggedPhrases": [
    { "phrase": string, "reason": string }
  ],
  "recommendations": [ string ]
}

Text to scan:
"""
${text.trim().substring(0, 4000)}
"""`;

  try {
    const messages = [
      { role: 'system', content: 'You are an academic integrity and plagiarism detection analyzer. Output only raw JSON.' },
      { role: 'user', content: prompt }
    ];
    const raw = await callGroq(messages, false, GROQ_TEXT_MODEL, 0.3);
    if (!raw) return res.status(503).json({ error: 'Plagiarism scan unavailable.' });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid JSON format');
    const scan = JSON.parse(jsonMatch[0]);

    res.json({ success: true, scan });
  } catch (err) {
    console.error('Plagiarism check error:', err);
    res.status(500).json({ error: 'Failed to complete originality scan.' });
  }
});

module.exports = router;


