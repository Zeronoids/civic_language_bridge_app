const test = require('node:test');
const assert = require('node:assert/strict');
const { claimContext, checkEvidence } = require('../evidence');

test('context is limited to this conversation and precedes the selected message', () => {
  const chat = { title: 'Policy', messages: Array.from({ length: 20 }, (_, i) => ({ translated: 'Message ' + i, original: 'Original ' + i })) };
  const context = claimContext(chat, 15);
  assert.equal(context.claim, 'Message 15');
  assert.equal(context.previousMessages.length, 12);
  assert.equal(context.previousMessages[0].text, 'Message 3');
  assert.equal(context.previousMessages.at(-1).text, 'Message 14');
});

test('search planning receives context, retrieves deduplicated extracts and preserves scope', async () => {
  const prompts = [], urls = [];
  const groq = { chat: { completions: { create: async request => {
    prompts.push(request);
    return { choices: [{ message: { content: JSON.stringify(prompts.length === 1
      ? { interpretation: 'Some policies fell short of their stated goals.', queries: ['policy outcomes', 'policy outcomes', 'policy evaluations'] }
      : { verdict: 'supported', status: 'Supported with qualifications', explanation: 'A documented example supports the limited claim [1].', caveat: 'Does not establish universal failure.', sourceIds: [1, 999] }) } }] };
  } } } };
  const fetcher = async url => {
    urls.push(url);
    const params = new URL(url).searchParams;
    return { ok: true, json: async () => params.get('list')
      ? { query: { search: [{ pageid: 17, title: 'Policy evaluation', snippet: '<b>Example</b> outcome' }] } }
      : { query: { pages: { 17: { extract: 'An evaluated program fell short of its target.' } } } } };
  };
  const context = { question: 'Did the programs meet their targets?', claim: 'Some of them failed.', previousMessages: [{ author: 'A', text: 'We are discussing program targets.' }] };
  const result = await checkEvidence(context, 'en', groq, fetcher);
  assert.equal(urls.length, 3);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].cited, true);
  assert.equal(result.sources[0].snippet, 'Example outcome');
  assert.match(prompts[0].messages[1].content, /program targets/);
  assert.match(prompts[1].messages[1].content, /fell short of its target/);
  assert.match(prompts[1].messages[0].content, /not a stronger version/);
  assert.equal(result.contextMessages, 1);
});

test('retrieval outage is an error, not a negative assessment of the claim', async () => {
  const groq = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"queries":["example"]}' } }] }) } } };
  await assert.rejects(checkEvidence({ claim: 'Example', previousMessages: [] }, 'en', groq, async () => { throw Error('offline'); }), /unavailable/);
});

test('a supported verdict with no retrieved evidence is rejected', async () => {
  let calls = 0;
  const groq = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(++calls === 1
    ? { queries: ['example'] }
    : { verdict: 'supported', status: 'Supported', explanation: 'Invented assertion.', sourceIds: [99] }) } }] }) } } };
  await assert.rejects(checkEvidence({ claim: 'Example', previousMessages: [] }, 'en', groq,
    async () => ({ ok: true, json: async () => ({ query: { search: [] } }) })), /citations/);
});
