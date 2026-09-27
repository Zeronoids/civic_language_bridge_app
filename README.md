# Civic Bridge

**Different languages. Common humanity.**

Civic Bridge is a hackathon prototype that adds a layer of understanding to communication. It helps people express themselves in their own language, consider the context behind a message, and find shared interests across different perspectives.

The ambition is to support conversations from community discussions to dialogue between leaders. This version demonstrates that idea through shared multilingual chat; it is not a secure platform for confidential or diplomatic communication.

## Features

- **Shared conversations:** Create named chats and reopen saved histories. Each chat has its own messages and summary.
- **Across languages:** Read in English, Spanish, French, German, Chinese, or Arabic. Expand a message to see the original wording.
- **Room for nuance:** AI-generated tone labels offer a possible interpretation, not a definitive account of someone's intent.
- **Speak and listen:** Dictate a draft with browser speech recognition or listen through ElevenLabs text-to-speech.
- **Explore references:** Request an AI-assisted assessment using retrieved Wikipedia search snippets, article introductions, and links.
- **Find common ground:** Summarize perspectives, friction points, and shared values in the selected conversation.

The responsive interface includes a conversation sidebar, language controls, expandable originals, and guidance for thoughtful dialogue, with keyboard focus styles and accessible control labels.

## How it works

1. A participant signs in through Auth0 and opens a shared conversation.
2. Socket.IO sends their message to the Node.js server.
3. Gemini translates it into English and suggests a tone and emoji. Processing failures fall back to the original text.
4. The server saves the message and broadcasts it to participants in that conversation.
5. Each viewer's browser requests another translation when their selected language is not English.

The submitted wording is preserved as the original. Summaries use the selected chat's English message history.

## Local setup

You need Node.js with npm, a Gemini API key, an ElevenLabs API key for audio playback, and an Auth0 Single Page Application configured for your URLs.

```sh
npm install
```

Copy `.env.example` to `.env` and fill in your keys:

```dotenv
GEMINI_API_KEY=your_gemini_key_here
ELEVENLABS_API_KEY=your_elevenlabs_key_here
```

| Optional variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP listening port | `3000` |
| `CHAT_FILE` | Saved conversation file path | `chats.json` in the project directory |

The Auth0 domain and client ID are configured in `public/index.html`. To use your own application, update `AUTH0_DOMAIN` and `AUTH0_CLIENT_ID`. Allow `http://localhost:3000` in its callback URLs, logout URLs, and web origins. Adjust the URL if you use another port.

```sh
npm start
```

Open `http://localhost:3000`. Keep API keys in the server environment, not in frontend code or committed files.

## Using Civic Bridge

1. Select **Join the conversation** and sign in.
2. Open a saved conversation or select **New conversation** to create one.
3. Set **Read & speak in** to your preferred language. This also selects the microphone recognition language.
4. Type or dictate a message, review it, then press **Send** or Enter.
5. Use **View original message**, **Check Evidence**, or **Listen** for more context.
6. Select **Find common ground** to summarize the current discussion.

All chats are shared and accessible to everyone. Refreshing or reconnecting restores the browser's last selected conversation.

## DigitalOcean deployment

Deploy as an App Platform **Web Service**:

| Setting | Value |
| --- | --- |
| Build command | Leave blank for automatic dependency installation |
| Run command | `npm start` or `node server.js` |
| HTTP port | `8080` |
| HTTP health-check path, if enabled | `/` |

Provide `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` as runtime environment variables. The server reads `PORT` from its environment. Add your deployed origin to Auth0's callback URLs, logout URLs, and web origins.

No frontend compilation is needed. Express serves the files in `public/`.

### Saved chats

Chats are saved through a temporary file and rename to `chats.json`. Existing single-chat history is loaded as **General discussion**. Run one server instance with this file-based implementation.

On persistent local disk, chats survive server restarts. **DigitalOcean App Platform's local filesystem is ephemeral**, so chats can disappear when a container is replaced or redeployed. Setting `CHAT_FILE` alone does not fix that. Durable hosted storage requires an external database or object storage integration, which this prototype does not yet implement. See [DigitalOcean's storage guidance](https://docs.digitalocean.com/products/app-platform/how-to/store-data/).

## Microphone input

Voice input uses the browser's `SpeechRecognition` or `webkitSpeechRecognition` implementation. It requires browser support, microphone permission, and HTTPS (or localhost). Participants can still type if recognition is unavailable.

Dictation preserves existing typed text and accumulates speech results. Sending or switching conversations cancels recognition so delayed callbacks cannot modify another draft. Permission and recognition errors appear below the composer.

## Checks

```sh
npm test
```

The automated checks simulate chat migration, saving and reloading, room isolation, summary scope, and speech-recognition events. Mocked services do not consume API credits. These checks do not verify physical microphone capture, live APIs, Auth0 configuration, or visual layout in a real browser.

Before a demo, open two browser sessions in different chats to check message isolation. Test microphone permission, several spoken phrases, stopping and sending, and switching chats. Also try translation, audio playback, evidence retrieval, and a summary on the deployed site.

## Project structure

```text
public/index.html              Interface markup and browser behavior
public/styles.css              Responsive visual design
server.js                      Routes, Socket.IO rooms, AI calls, persistence
tests/chat-and-speech.test.js   Mocked regression checks
.env.example                   Required API-key placeholders
```

## Prototype boundaries

- Auth0 gates the interface; the backend does not verify access tokens or enforce private-chat permissions.
- Translations, tone interpretations, evidence assessments, and summaries can be incorrect. Original wording and participant clarification remain essential.
- Evidence checks use Wikipedia snippets and introductory extracts, not comprehensive research or authoritative verification.
- Storage and message delivery assume one server instance. External persistence, access controls, and abuse protection are needed before broader production use.

## Participant judgment and civic questions

New conversations can include a community question. Summaries attribute perspectives to speakers and request numbered message references, open questions, and one suggested next step. The source-message list lets participants revisit the original words.

Participants represented in a summary can choose **That captures my view** or **Clarify my view**. Responses are saved alongside that specific summary and shared live. New messages produce a new summary version; earlier confirmations do not transfer. Common ground remains AI-suggested, and silence never counts as agreement.

Message authors can hide or dispute their tone label, or restore it. Hidden/disputed labels also stop influencing voice playback settings. Evidence assessments now use **Supported by retrieved references**, **Conflicting evidence**, or **Insufficient evidence**, with an instruction to account for the limits of search snippets.

Feedback ownership uses a random browser token, hashed on the server. It is not verified Auth0 identity, a vote, or proof of consensus. Changing browsers or clearing local storage loses access to that browser's feedback controls. Existing messages created before this feature have no ownership token. Server-side verified identity remains future work.


### Context-aware evidence checks

Evidence checks read the selected message and up to 12 preceding messages from the same chat, plus its community question. Context helps interpret the claim but is never treated as independent proof. One Gemini call plans up to three targeted searches, then a second assesses up to six Wikipedia references. This uses more tokens than the previous single-call check.

Assessments preserve qualifiers such as "some" and separate factual support from ambiguous judgments such as "failed". The interface exposes the interpretation, search queries, numbered references, and retrieved excerpts. Retrieval outages show an error rather than judging the claim. Results can still miss evidence; no particular verdict is guaranteed.


Gemini uses the native generateContent API through `gemini.js`. Set `GEMINI_API_KEY` locally and in DigitalOcean runtime variables. `GEMINI_MODEL` optionally overrides the default `gemini-2.5-flash`; choose a text model available to your API project that supports JSON output. ElevenLabs remains responsible for audio playback. Node.js 20 or newer is recommended for the built-in fetch transport.
