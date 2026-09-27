require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Gemini = require('./gemini');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const gemini = new Gemini({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', timeout: 30000 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Shared saved conversations. CHAT_FILE can point to persistent storage.
const { randomUUID, createHash } = require('crypto');
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
const chatList = () => chats.map(({ id, title, question }) => ({ id, title, question }));
const queues = new Map();

// WebSocket Handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  const token = socket.handshake?.auth?.participantToken;
  const participantId = typeof token === 'string' && token.length >= 32 && token.length <= 200
    ? createHash('sha256').update(token).digest('hex') : null;
  socket.emit('participant identity', participantId);

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
  socket.on('create chat', payload => {
    const title = typeof payload === 'string' ? payload : payload?.title;
    const question = typeof payload?.question === 'string' ? payload.question.trim().slice(0, 300) : '';
    if (typeof title !== 'string' || !title.trim() || title.length > 80) return socket.emit('chat error', 'Use a chat title of 1 to 80 characters.');
    const chat = { id: randomUUID(), title: title.trim(), question, messages: [] };
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

  socket.on('tone feedback', data => {
    const chat = chats.find(c => c.id === socket.data.chatId);
    const message = chat?.messages.find(m => m.id === data?.messageId);
    if (!participantId || !message || message.participantId !== participantId || !['hidden', 'disputed', 'visible'].includes(data.state)) return;
    const previous = message.toneFeedback;
    message.toneFeedback = data.state;
    try { saveHistory(); } catch (_) { message.toneFeedback = previous; return socket.emit('chat error', 'Could not save tone feedback.'); }
    io.to(chat.id).emit('tone updated', { messageId: message.id, state: data.state });
  });
  socket.on('summary feedback', data => {
    const chat = chats.find(c => c.id === socket.data.chatId);
    const snapshot = chat?.summaries?.find(item => item.id === data?.summaryId);
    if (!participantId || !snapshot || !snapshot.participants.includes(participantId) || !['confirmed', 'clarified'].includes(data.state)) return socket.emit('chat error', 'Only participants represented in this summary can respond.');
    const clarification = typeof data.text === 'string' ? data.text.trim().slice(0, 1500) : '';
    if (data.state === 'clarified' && !clarification) return;
    const author = chat.messages.find(m => m.participantId === participantId)?.author || 'Participant';
    const previous = snapshot.feedback;
    snapshot.feedback = [...previous.filter(f => f.participantId !== participantId), { participantId, author, state: data.state, text: clarification }];
    try { saveHistory(); } catch (_) { snapshot.feedback = previous; return socket.emit('chat error', 'Could not save summary feedback.'); }
    io.to(chat.id).emit('summary feedback updated', { summaryId: snapshot.id, feedback: snapshot.feedback });
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
      const response = await gemini.chat.completions.create({
        messages: [
          { role: 'system', content:
            'You are an AI civic mediator. Respond with valid JSON only. ' +
            'Translate the incoming message into clear English (if already English, keep it as is). ' +
            'Analyze the emotional subtext and tone. Pick one fitting emoji. ' +
            'Schema: {"original":"...","translated":"...","tone":"...","emoji":"..."}' },
          { role: 'user', content: textContent }
        ],
        response_format: { type: 'json_object' }, temperature: 0.2
      });
      const parsedData = JSON.parse(response.choices[0].message.content);
      if (!parsedData || ['translated', 'tone', 'emoji'].some(key => typeof parsedData[key] !== 'string')) {
        throw new Error('Invalid mediator response');
      }
      parsedData.original = textContent;
      parsedData.author = author;

      outgoing = parsedData;
    } catch (error) {
      console.error('Gemini processing error detail:', error);
      const fallback = {
        author,
        original: textContent,
        translated: textContent,
        tone: 'Direct',
        emoji: '💬'
      };
      outgoing = fallback;
    }
    outgoing.participantId = participantId;
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
      let code = '';
      try { code = JSON.parse(err).detail?.status || ''; } catch (_) {}
      const error = code === 'quota_exceeded' ? 'ElevenLabs credits exhausted. Check your account quota.'
        : [401, 403].includes(response.status) ? 'ElevenLabs access denied. Check ELEVENLABS_API_KEY and its permissions on the server.'
        : response.status === 429 ? 'ElevenLabs rate limit reached. Please retry shortly.'
        : 'ElevenLabs audio generation failed. Check the server logs for the provider error.';
      return res.status(response.status).json({ error });
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('TTS server error:', err);
    res.status(503).json({ error: 'Audio service could not be reached or timed out. Please retry.' });
  }
});

// Context-aware evidence retrieval and scoped assessment.
const { claimContext, checkEvidence } = require('./evidence');
app.post('/api/factcheck', async (req, res) => {
  const { chatId, messageId, messageIndex, targetLang } = req.body || {};
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return res.status(404).json({ error: 'Conversation not found' });
  const index = typeof messageId === 'string' ? chat.messages.findIndex(m => m.id === messageId) : messageIndex;
  if (!Number.isInteger(index) || index < 0 || index >= chat.messages.length) return res.status(404).json({ error: 'Message not found' });
  const language = targetLang || 'en';
  if (!['en', 'es', 'fr', 'de', 'zh', 'ar'].includes(language)) return res.status(400).json({ error: 'Invalid language' });
  try {
    res.json(await checkEvidence(claimContext(chat, index), language, gemini));
  } catch (error) {
    console.error('Evidence retrieval error:', error);
    res.status(error.status || 503).json({ error: error.publicMessage || 'Evidence retrieval is temporarily unavailable. Please retry.' });
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

  const revision = chat.messages.length;
  const cached = chat.summaries?.find(item => item.revision === revision);
  if (cached) return res.json(cached);
  const sources = messageHistory.map((m, index) => ({ number: index + 1, id: m.id, author: m.author || 'Participant', text: m.original, participantId: m.participantId }));
  // Include speaker attribution and stable message references.
  const dialogue = messageHistory
    .map((m, idx) => `[Message ${idx + 1}] ${m.author || "Participant"}: "${m.translated}"`)
    .join('\n');

  try {
    const response = await gemini.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            'You are a neutral civic mediator specializing in constructive debate and conflict resolution. ' +
            'Analyze the provided chat dialogue and produce a fair, balanced, and impartial summary. ' +
            'Use markdown headings: Core Perspectives, Key Friction Points, AI-suggested Common Ground, Open Questions, Suggested Next Step. ' +
            'Attribute each perspective to its speaker and cite supporting messages as [Message N]. ' +
            'Never infer agreement from silence. Common ground and next steps are tentative suggestions, not collective decisions. ' +
            'Include unresolved differences and uncertainties. Suggest one feasible civic action without assigning commitments.'
        },
        { role: 'user', content: `Community question: ${chat.question || chat.title}\nDialogue:\n${dialogue}` }
      ],
      model: 'qwen/qwen3.8-27b',
      temperature: 0.2
    });

    const concurrent = chat.summaries?.find(item => item.revision === revision);
    if (concurrent) return res.json(concurrent);
    const snapshot = { id: randomUUID(), revision, summary: response.choices[0].message.content,
      sources, participants: [...new Set(sources.map(m => m.participantId).filter(Boolean))], feedback: [] };
    chat.summaries ||= [];
    chat.summaries.push(snapshot);
    try { saveHistory(); } catch (error) { chat.summaries.pop(); throw error; }
    res.json(snapshot);
  } catch (err) {
    console.error('Summarize error:', err);
    res.status(err.status || 503).json({ error: err.publicMessage || 'Summary generation is temporarily unavailable.' });
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
    const response = await gemini.chat.completions.create({
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

    const translated = response.choices[0]?.message?.content?.trim();
    if (!translated) throw new Error('Empty translation response');
    res.json({ translated });
  } catch (err) {
    console.error('Target translation error:', err);
    const status = err.status || 503;
    res.set('Retry-After', '3');
    res.status(status).json({ error: err.publicMessage || 'Translation temporarily unavailable' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
