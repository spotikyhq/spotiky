import worker from './worker.mjs';
let prompt = '';
globalThis.fetch = async (url) => { url = String(url);
  if (url.includes('oembed')) return new Response(JSON.stringify({ title: 'Blinding Lights' }), { status: 200 });
  if (url.includes('zh-words')) return new Response('{}', { status: 200 });
  return new Response('<a href="/artist/' + 'Z'.repeat(22) + '">The Weeknd</a>', { status: 200 }); };
const env = { CODES: { async get() { return null; }, async put() {} }, AI: { async run(m, input) { prompt = input.messages.map(x => x.content).join('\n'); return { response: '{}' }; } } };
await worker.fetch(new Request('https://w.dev/suggest', { method: 'POST', body: JSON.stringify({ type: 'track', id: 'A'.repeat(21) + '1' }) }), env);
const cps = [...prompt];
const ascii = cps.filter(c => c.codePointAt(0) < 128).length, astral = cps.filter(c => c.codePointAt(0) > 0xFFFF).length;
console.log({ chars: cps.length, ascii, astral, otherNonAscii: cps.length - ascii - astral });
// Rough token estimate: ~4 ASCII characters per token, ~2.5 tokens per emoji or hieroglyph (4-byte characters)
const tokensIn = Math.round(ascii / 4 + astral * 2.5 + (cps.length - ascii - astral) * 1.5);
const tokensOut = 700;
const cost = tokensIn * 0.0509 / 1e6 + tokensOut * 0.335 / 1e6;
console.log({ tokensIn, tokensOut, costPerCall: cost.toFixed(6), callsPerFreeDay: Math.floor(0.11 / cost) });
