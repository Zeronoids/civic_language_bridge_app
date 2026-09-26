require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 20000, maxRetries: 0 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Shared saved conversations. CHAT_FILE can point to persistent storage.
const { randomUUID } = require('crypto');
const CHAT_FILE = process.env.CHAT_FILE || path.join(__dirname, 'chats.json');
let chats = [{ id: 'general', title: 'General discussion', messages: [] }];
if (fs.existsSync(CHAT_FILE)) {
  const saved = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  if (Array.isArray(saved)) chats[0].messages = saved; // Preserve the original single chat.
  else if (saved.version === 2 && Array.isArray(saved.chats) && saved.chats.length) chats = saved.chats;
  else throw new Error('Unsupported chat file; refusing to overwrite it');
}
function saveHistory() {
  fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
  fs.writeFileSync(CHAT_FILE + '.tmp', JSON.stringify({ version: 2, chats }, null, 2));
  fs.renameSync(CHAT_FILE + '.tmp', CHAT_FILE);
}
const chatList = () => chats.map(({ id, title }) => ({ id, title }));
const queues = new Map();

// WebSocket Handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send prior conversation to newly joined client
  socket.emit('chat list', chatList());
  function joinChat(id) {
    const chat = chats.find(c => c.id === id);
    if (!chat) return socket.emit('chat error', 'Chat not found.');
    if (socket.data.chatId) socket.leave(socket.data.chatId);
    socket.data.chatId = id;
    socket.join(id);
    socket.emit('chat history', { chatId: id, messages: chat.messages });
  }
  socket.on('join chat', joinChat);
  socket.on('create chat', title => {
    if (typeof title !== 'string' || !title.trim() || title.length > 80) return socket.emit('chat error', 'Use a chat title of 1 to 80 characters.');
    const chat = { id: randomUUID(), title: title.trim(), messages: [] };
    chats.push(chat);
    try { saveHistory(); }
    catch (error) {
      chats.pop();
      console.error(error);
      return socket.emit('chat error', 'Could not save the new chat.');
    }
    io.emit('chat list', chatList());
    joinChat(chat.id);
  });

  socket.on('chat message', (data) => {
    if (!data || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 5000) {
      socket.emit('chat error', 'Messages must contain 1 to 5000 characters.');
      return;
    }
    const chat = chats.find(c => c.id === data.chatId && c.id === socket.data.chatId);
    if (!chat) return socket.emit('chat error', 'Select a chat before sending.');
    const author = typeof data.author === 'string' ? data.author.slice(0, 100) : 'Participant';
    const textContent = data.text.trim();
    const pending = (queues.get(chat.id) || Promise.resolve()).then(async () => {
    let outgoing;

    try {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are an AI civic mediator. You MUST respond with valid JSON only. ' +
              'Translate the incoming message into clear English (if it is already English, keep it as is). ' +
              'Analyze the emotional subtext and tone (e.g., Frustrated, Skeptical, Passionate, Constructive, Inquisitive, Calm). ' +
              'Pick one single fitting emoji. ' +
              'Schema: {"original": "...", "translated": "...", "tone": "...", "emoji": "..."}'
          },
          { role: 'user', content: textContent }
        ],
        model: 'qwen/qwen3.8-27b',
        response_format: { type: 'json_object' },
        temperature: 0.2
      });

      const parsedData = JSON.parse(chatCompletion.choices[0].message.content);
      if (!parsedData || ['translated', 'tone', 'emoji'].some(key => typeof parsedData[key] !== 'string')) {
        throw new Error('Invalid mediator response');
      }
      parsedData.original = textContent;
      parsedData.author = author;

      outgoing = parsedData;
    } catch (error) {
      console.error('Groq processing error detail:', error);
      const fallback = {
        author,
        original: textContent,
        translated: textContent,
        tone: 'Direct',
        emoji: '💬'
      };
      outgoing = fallback;
    }
    outgoing.id = randomUUID();
    outgoing.chatId = chat.id;
    chat.messages.push(outgoing);
    try { saveHistory(); }
    catch (error) {
      chat.messages.pop();
      socket.emit('chat error', 'Message could not be saved. Please resend it.');
      throw error;
    }
    io.to(chat.id).emit('chat message', outgoing);
    }).catch(error => console.error('Message processing failed:', error));
    queues.set(chat.id, pending);
  });
});

// ElevenLabs Text-to-Speech Route
app.post('/api/tts', async (req, res) => {
  const { text, tone } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 5000) return res.status(400).send('Text is required');

  let stability = 0.5;
  let style = 0.0;
  const lowerTone = typeof tone === 'string' ? tone.toLowerCase() : '';

  if (lowerTone.includes('frustrated') || lowerTone.includes('angry')) {
    stability = 0.3;
    style = 0.45;
  } else if (lowerTone.includes('passionate') || lowerTone.includes('hopeful')) {
    stability = 0.4;
    style = 0.35;
  } else if (lowerTone.includes('calm') || lowerTone.includes('constructive')) {
    stability = 0.75;
    style = 0.1;
  }

  const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability, similarity_boost: 0.75, style }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs API returned error:', err);
      return res.status(response.status).send(err);
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('TTS server error:', err);
    res.status(500).send('Audio generation failed');
  }
});

// LIVE FACT-CHECKING ROUTE (Multilingual Localized Output)
app.post('/api/factcheck', async (req, res) => {
  const { claim, targetLang } = req.body || {};
  if (typeof claim !== 'string' || !claim.trim() || claim.length > 5000) return res.status(400).send('Claim is required');

  const language = targetLang || 'en';

  try {
    const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(claim)}&utf8=&format=json&origin=*`;
    const searchRes = await fetch(wikiSearchUrl, { signal: AbortSignal.timeout(10000) });
    const searchJson = await searchRes.json();

    const searchResults = (searchJson.query && searchJson.query.search) || [];
    const topResults = searchResults.slice(0, 3);

    let searchContext = 'No direct historical or civic documents found.';
    let sources = [];

    if (topResults.length > 0) {
      searchContext = topResults.map(r => {
        const cleanSnippet = r.snippet.replace(/<\/?[^>]+(>|$)/g, '');
        return `Title: ${r.title}\nSnippet: ${cleanSnippet}\nURL: https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`;
      }).join('\n\n');

      sources = topResults.slice(0, 2).map(r => ({
        title: r.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`
      }));
    }

    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            `You are an impartial civic fact-checker. Respond with JSON only. ` +
            `Evaluate the user claim strictly against the provided reference evidence. ` +
            `Write the status and explanation in the target language: "${language}". ` +
            `Status must be the localized equivalent of ("Verified", "Questionable", or "Needs Context"). ` +
            `Provide a concise 1-2 sentence neutral explanation in "${language}". ` +
            `Schema: {"status": "...", "explanation": "...", "sources": [{"title": "...", "url": "..."}]}`
        },
        {
          role: 'user',
          content: `Claim: "${claim}"\n\nReference Evidence:\n${searchContext}`
        }
      ],
      model: 'qwen/qwen3.8-27b',
      response_format: { type: 'json_object' },
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content);
    result.sources = sources; // Only link to references actually retrieved.

    res.json(result);
  } catch (err) {
    console.error('Fact-check error:', err);
    res.status(500).json({ status: 'Error', explanation: 'Failed to complete evidence retrieval.', sources: [] });
  }
});

// CIVIC SUMMARY ROUTE (Structured Multi-Perspective Synthesis)
app.get('/api/summarize', async (req, res) => {
  const chat = chats.find(c => c.id === req.query.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const messageHistory = chat.messages;
  if (messageHistory.length === 0) {
    return res.json({ 
      summary: "No discussion has taken place yet. Send a few messages across different perspectives first!" 
    });
  }

  // Format full dialogue with tones for the model
  const dialogue = messageHistory
    .map((m, idx) => `[Message ${idx + 1}] "${m.translated}" (Tone: ${m.tone})`)
    .join('\n');

  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            'You are a neutral civic mediator specializing in constructive debate and conflict resolution. ' +
            'Analyze the provided chat dialogue and produce a fair, balanced, and impartial summary. ' +
            'Use markdown formatting with these exact sections:\n' +
            '### 📌 Core Perspectives\n(Summarize the different arguments presented without taking sides)\n\n' +
            '### ⚡ Key Friction Points\n(Highlight where values, facts, or priorities clash)\n\n' +
            '### 🤝 Common Ground & Shared Values\n(Identify any mutual interests, shared goals, or bridge opportunities)'
        },
        { role: 'user', content: `Dialogue:\n${dialogue}` }
      ],
      model: 'qwen/qwen3.8-27b',
      temperature: 0.2
    });

    res.json({ summary: response.choices[0].message.content });
  } catch (err) {
    console.error('Summarize error:', err);
    res.status(500).json({ summary: 'Failed to generate civic discourse summary.' });
  }
});

// Dynamic per-user translation endpoint
app.post('/api/translate', async (req, res) => {
  const { text, targetLang } = req.body || {};
  if (typeof text !== 'string' || text.length > 5000) return res.status(400).json({ error: 'Invalid text' });
  if (!['en', 'es', 'fr', 'de', 'zh', 'ar'].includes(targetLang)) return res.status(400).json({ error: 'Invalid language' });
  if (targetLang === 'en') {
    return res.json({ translated: text });
  }

  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Translate the input text accurately into ${targetLang}. Return ONLY the translated string with no quotes, commentary, or markdown.`
        },
        { role: 'user', content: text }
      ],
      model: 'qwen/qwen3.8-27b',
      temperature: 0.2
    });

    res.json({ translated: response.choices[0].message.content.trim() });
  } catch (err) {
    console.error('Target translation error:', err);
    res.json({ translated: text });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
