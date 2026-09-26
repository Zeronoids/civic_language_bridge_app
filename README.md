# civic_language_bridge_app

Run `npm install`, configure the keys from `.env.example`, then run `npm start`.

Use **New chat** to name a conversation and **Saved chats** to reopen one.
Chats are shared with everyone, not private to an Auth0 account. Each chat has
its own history, live messages and summary. Refreshing/reconnecting restores
the last selected chat. Existing single-chat history becomes General discussion.

Chats are saved atomically to `chats.json`. Set `CHAT_FILE` to override the path.
Run only one server instance with this file-based storage. On a normal persistent
disk, chats survive server restarts. DigitalOcean App Platform's local filesystem
is ephemeral: chats can be lost when the container is replaced or redeployed.
Durability there requires external storage (a database or Spaces), which this
version does not configure. Merely setting CHAT_FILE does not make App Platform
storage persistent.

Microphone input uses the browser's SpeechRecognition implementation and the
selected language. Use HTTPS (or localhost), allow microphone access, and click
the microphone to dictate. Existing typed text is preserved; review before
sending. Switching chats or sending cancels recognition so late results cannot
modify another draft. Unsupported browsers can still use typed input.

Run `npm test` for mocked chat persistence/isolation, summary scope, and speech
lifecycle tests. These do not test physical microphone capture or external APIs.
For the demo, check the deployed site with a real microphone: allow permission,
dictate multiple phrases, stop, verify the text, send, and repeat after switching
chats. Also check denied permission and the selected speech language.
