require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// Global in-memory log for the conversation
const messageHistory = [];

// WebSocket Handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('chat message', async (msg) => {
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
          { role: 'user', content: msg }
        ],
        model: 'qwen/qwen3.8-27b',
        response_format: { type: 'json_object' },
        temperature: 0.2
      });

      const parsedData = JSON.parse(chatCompletion.choices[0].message.content);
      
      // Save to server history for summarization
      messageHistory.push(parsedData);
      
      io.emit('chat message', parsedData);
    } catch (error) {
      console.error('Groq processing error detail:', error);
      const fallback = {
        original: msg,
        translated: msg,
        tone: 'Direct',
        emoji: '💬'
      };
      messageHistory.push(fallback);
      io.emit('chat message', fallback);
    }
  });
});

// ElevenLabs Text-to-Speech Route
app.post('/api/tts', async (req, res) => {
  const { text, tone } = req.body;
  if (!text) return res.status(400).send('Text is required');

  let stability = 0.5;
  let style = 0.0;
  const lowerTone = (tone || '').toLowerCase();

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

// LIVE FACT-CHECKING ROUTE (Open Wikipedia REST API + LLM Synthesis)
app.post('/api/factcheck', async (req, res) => {
  const { claim } = req.body;
  if (!claim) return res.status(400).send('Claim is required');

  try {
    // 1. Query the open Wikipedia search endpoint (100% free, no key needed)
    const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(claim)}&utf8=&format=json&origin=*`;
    const searchRes = await fetch(wikiSearchUrl);
    const searchJson = await searchRes.json();

    const searchResults = (searchJson.query && searchJson.query.search) || [];
    const topResults = searchResults.slice(0, 3);

    let searchContext = 'No direct historical or civic documents found.';
    let sources = [];

    if (topResults.length > 0) {
      searchContext = topResults.map(r => {
        // Strip out HTML tags Wikipedia returns in snippets
        const cleanSnippet = r.snippet.replace(/<\/?[^>]+(>|$)/g, '');
        return `Title: ${r.title}\nSnippet: ${cleanSnippet}\nURL: https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`;
      }).join('\n\n');

      sources = topResults.slice(0, 2).map(r => ({
        title: r.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`
      }));
    }

    // 2. Synthesize using Qwen with the retrieved context
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            'You are an impartial civic fact-checker. You MUST respond with JSON only. ' +
            'Evaluate the user claim strictly against the provided reference evidence. ' +
            'Determine status: "Verified", "Questionable", or "Needs Context". ' +
            'Provide a 1-2 sentence neutral explanation and confirm sources. ' +
            'Schema: {"status": "...", "explanation": "...", "sources": [{"title": "...", "url": "..."}]}'
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
    
    // Ensure verified clickable sources are always attached
    if (!result.sources || result.sources.length === 0) {
      result.sources = sources;
    }

    res.json(result);
  } catch (err) {
    console.error('Fact-check error:', err);
    res.status(500).json({ status: 'Error', explanation: 'Failed to complete evidence retrieval.', sources: [] });
  }
});

// CIVIC SUMMARY ROUTE (Structured Multi-Perspective Synthesis)
app.get('/api/summarize', async (req, res) => {
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});