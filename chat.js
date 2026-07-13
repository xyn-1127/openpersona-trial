// Chat with a generated persona (Ollama). On exit, an evolution-enabled persona
// updates its own state via scripts/state-sync.js.
// Usage: node chat.js [persona-slug]   (default: rosa-mendez)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const DEFAULT_SLUG = 'rosa-mendez';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';

const slug = process.argv[2] || DEFAULT_SLUG;
const dir = path.resolve(`persona-${slug}`);

if (!fs.existsSync(dir)) {
  console.error(`Persona not found: persona-${slug}/`);
  console.error(`Generate it first, e.g.: npx openpersona create --config ./${slug}.json`);
  process.exit(1);
}

const soul = fs.readFileSync(path.join(dir, 'soul', 'injection.md'), 'utf-8')
  .replace(/<!--[^>]*-->/g, '')
  .trim();

const personaJson = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf-8'));
const personaName = personaJson.personaName || personaJson.soul?.identity?.personaName || slug;
const evolutionEnabled = personaJson.evolution?.instance?.enabled === true;

function identityPrompt(persona) {
  const bio = persona.bio || persona.soul?.identity?.bio;
  const personality = persona.personality || persona.soul?.character?.personality;
  const speakingStyle = persona.speakingStyle || persona.soul?.character?.speakingStyle;

  return [
    'Adopt the following persona identity consistently throughout the conversation:',
    `Name: ${personaName}`,
    bio ? `Background: ${bio}` : null,
    personality ? `Core personality: ${personality}` : null,
    speakingStyle ? `Speaking style: ${speakingStyle}` : null,
    'Use this background when answering personal or situational questions, while following the safety and self-awareness rules below.'
  ].filter(Boolean).join('\n');
}

function stateSync(args) {
  try {
    return execFileSync('node', [path.join('scripts', 'state-sync.js'), ...args],
      { cwd: dir, encoding: 'utf-8' });
  } catch {
    return null;
  }
}

function evolutionBriefing(state) {
  if (!state?.exists) return null;

  const currentState = {
    relationship: state.relationship,
    mood: state.mood,
    evolvedTraits: state.evolvedTraits || [],
    speakingStyleDrift: state.speakingStyleDrift,
    interests: state.interests || {},
    recentEvents: state.recentEvents || [],
    pendingCommands: state.pendingCommands || []
  };

  return [
    'This is your persisted evolution state from previous conversations:',
    JSON.stringify(currentState, null, 2),
    'Use this state throughout the conversation. Let the relationship stage, mood, evolved traits, speaking style, and interests shape how you respond.'
  ].join('\n');
}

console.log(`\n  Persona: ${personaName} (${slug})`);
console.log(`  Model:   ${MODEL} (Ollama)`);

let initialState = null;
if (evolutionEnabled) {
  const raw = stateSync(['read']);
  if (raw) {
    try {
      initialState = JSON.parse(raw);
      console.log(`  Stage:   ${initialState.relationship?.stage}  |  mood: ${initialState.mood?.current || initialState.mood?.baseline}  |  interactions: ${initialState.relationship?.interactionCount}`);
    } catch { /* ignore */ }
  }
} else {
  console.log(`  Evolution: off`);
}
console.log(`  Type your message. Type "exit" or Ctrl+C to quit.\n`);

const messages = [
  { role: 'system', content: identityPrompt(personaJson) },
  { role: 'system', content: soul }
];

const briefing = evolutionBriefing(initialState);
if (briefing) messages.push({ role: 'system', content: briefing });

let inFlight = 0;
let closing = false;

async function callOllama() {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, messages })
  });
  const data = await res.json();
  if (!data.message) throw new Error('Ollama error: ' + JSON.stringify(data));
  return data.message.content;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// One line at a time, so a reply finishes before the next line is read (matters when piped).
function ask() {
  rl.question('you > ', async (line) => {
    const text = line.trim();
    if (text === 'exit' || text === 'quit') { rl.close(); return; }
    if (!text) { ask(); return; }

    messages.push({ role: 'user', content: text });
    inFlight++;
    try {
      const reply = await callOllama();
      messages.push({ role: 'assistant', content: reply });
      console.log(`\n${personaName} > ${reply}\n`);
    } catch (err) {
      console.error('Error:', err.message);
    }
    inFlight--;
    if (closing) { finalize(); return; }
    ask();
  });
}

async function callOllamaWith(msgs) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, messages: msgs })
  });
  const data = await res.json();
  if (!data.message) throw new Error('Ollama error: ' + JSON.stringify(data));
  return data.message.content;
}

function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

// At conversation end: ask the model for a state patch, write it through the gate,
// and append a journal line on a milestone.
async function evolve() {
  let state = {};
  try { state = JSON.parse(stateSync(['read'])); } catch { /* ignore */ }
  const nextCount = (state.relationship?.interactionCount || 0) + 1;

  const convo = messages.filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'User' : personaName}: ${m.content}`).join('\n');

  const instr =
`You are ${personaName}. The conversation below just ended. Update your own evolution state.

Current state:
- relationship.stage: ${state.relationship?.stage}
- interactionCount: ${state.relationship?.interactionCount}
- mood: ${state.mood?.current || state.mood?.baseline}
- speakingStyleDrift.formality: ${state.speakingStyleDrift?.formality} (allowed range -3..7)
- evolvedTraits: ${JSON.stringify(state.evolvedTraits || [])}
- interests: ${JSON.stringify(Object.keys(state.interests || {}))}

Relationship stage advances ONE step at a time (never skip, never reverse). Advance as soon as the threshold is met:
stranger -> acquaintance: 3+ meaningful exchanges and the user shared something personal
acquaintance -> friend: interactionCount >= 10 with recurring shared topics and warmth or humor
If the current interactionCount already meets the next threshold and the rapport is clearly there, you SHOULD advance one step.

Output ONLY a JSON object (no other text) with the keys that actually changed:
{"relationship":{"interactionCount":${nextCount},"stage":"<keep or advance one step>"},
 "mood":{"current":"..."},
 "speakingStyleDrift":{"formality":<int -3..7>},
 "evolvedTraits":["..."],
 "interests":{"topic":0.6},
 "eventLog":[{"type":"relationship_signal|mood_shift|trait_emergence|interest_discovery","trigger":"short phrase","delta":"what changed","source":"user"}],
 "narrative":"<1-2 sentence first-person journal note, ONLY if a real milestone happened; otherwise omit this key>"}

Conversation:
${convo}`;

  let patch;
  try {
    patch = extractJson(await callOllamaWith([{ role: 'user', content: instr }]));
  } catch (err) {
    console.error('  (evolve: model error)', err.message);
    return;
  }
  if (!patch) { console.log('  (evolve: no valid patch produced)'); return; }

  // Drop malformed eventLog entries (state-sync rejects the whole write on a bad one).
  if (Array.isArray(patch.eventLog)) {
    const VALID = new Set(['relationship_signal', 'mood_shift', 'trait_emergence', 'interest_discovery', 'milestone', 'speaking_style_drift']);
    patch.eventLog = patch.eventLog
      .filter(ev => ev && typeof ev === 'object' && VALID.has(ev.type) && ev.trigger && ev.delta)
      .map(ev => ({ ...ev, source: ev.source || 'conversation' }));
    if (!patch.eventLog.length) delete patch.eventLog;
  }

  const narrative = patch.narrative;
  delete patch.narrative;
  patch.relationship = { ...(patch.relationship || {}), interactionCount: nextCount, lastInteraction: new Date().toISOString() };

  if (stateSync(['write', JSON.stringify(patch)]) !== null) {
    console.log(`\n  Evolution state updated (interaction #${nextCount}).`);
  }
  if (typeof narrative === 'string' && narrative.trim()) {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, 'soul', 'self-narrative.md'), `\n### ${day}\n${narrative.trim()}\n`);
    console.log(`  Journal entry appended to self-narrative.md.`);
  }
}

async function finalize() {
  if (evolutionEnabled) {
    try { await evolve(); } catch (err) { console.error('  evolve failed:', err.message); }
  }
  console.log('  Bye.\n');
  process.exit(0);
}

rl.on('close', () => { closing = true; if (inFlight === 0) finalize(); });

ask();
