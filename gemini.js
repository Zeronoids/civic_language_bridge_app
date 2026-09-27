// Native Gemini REST transport; preserves the app's internal completion shape.
class Gemini {
  constructor({ apiKey, model = 'gemini-3.8-flash', timeout = 30000, fetcher = fetch } = {}) {
    if (!apiKey) throw new Error('Set GEMINI_API_KEY in your server environment.');
    this.model = model;
    this.chat = { completions: { create: async ({ messages, temperature = 0.2, response_format }) => {
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const body = {
        contents: messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }]
        })),
        generationConfig: { temperature, responseMimeType: response_format?.type === 'json_object' ? 'application/json' : 'text/plain' }
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const send = () => fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
      });
      let response = await send();
      if ([502, 503, 504].includes(response.status)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await send();
      }
      if (!response.ok) {
        // Do not log response bodies or request headers that could expose credentials.
        const error = new Error(`Gemini request failed (HTTP ${response.status}). Check model access, API key and quota.`);
        error.status = response.status;
        error.publicMessage = ({
          400: 'Gemini rejected the request. Check the server API key and model configuration.',
          401: 'Gemini authentication failed. Check GEMINI_API_KEY on the server.',
          403: 'Gemini access denied. Check API-key permissions and project access.',
          404: 'Gemini model unavailable. Set GEMINI_MODEL to gemini-3.8-flash and restart the server.',
          429: 'Gemini quota or rate limit reached. Wait before retrying or check your Google AI Studio quota.'
        })[response.status] || 'Gemini is temporarily unavailable. Please retry.';
        throw error;
      }
      const result = await response.json();
      const candidate = result.candidates?.[0];
      if (result.promptFeedback?.blockReason || candidate?.finishReason !== 'STOP') {
        throw new Error('Gemini returned a blocked or incomplete response.');
      }
      const text = (candidate.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('').trim();
      if (!text) throw new Error('Gemini returned no text.');
      return { choices: [{ message: { content: text } }] };
    } } };
  }
}
module.exports = Gemini;
