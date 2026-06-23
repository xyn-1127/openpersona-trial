// Ask a generated persona a list of survey questions; save the answers to a CSV.
// The questions below are example placeholders, not a real research instrument.
// Usage: node survey-chat.js [persona-slug]   (default: rosa-mendez)

const fs = require('fs');
const path = require('path');

const DEFAULT_SLUG = 'rosa-mendez';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';

const QUESTIONS = [
  'On a scale of 1 to 5, how satisfied are you with your daily life, and why?',
  'What is the biggest challenge you face from week to week?',
  'How do you feel about the cost of living where you live?',
  'What matters most to you when you make decisions for your family?',
  'If you had a free afternoon to yourself, how would you spend it?'
];

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
const personaName = personaJson.personaName || slug;

// If evolution is on, inject the current state so the answers reflect it.
const evolutionEnabled = personaJson.evolution?.instance?.enabled === true;

function evolutionBriefing() {
  if (!evolutionEnabled) return null;
  const statePath = path.join(dir, 'state.json');
  if (!fs.existsSync(statePath)) return null;
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const traits = (s.evolvedTraits || []).map(t => (typeof t === 'string' ? t : t.trait || JSON.stringify(t)));
  const interests = Object.keys(s.interests || {});
  return [
    'Your current evolution state — let it shape your tone and what you bring up:',
    `- Relationship with this person: ${s.relationship?.stage} (${s.relationship?.interactionCount} interactions so far)`,
    `- Mood: ${s.mood?.current || s.mood?.baseline}`,
    `- Speaking-style drift: formality ${s.speakingStyleDrift?.formality} (lower = more casual and open)`,
    `- Evolved traits to express: ${traits.length ? traits.join(', ') : 'none yet'}`,
    `- Interests you have discovered and may mention: ${interests.length ? interests.join(', ') : 'none yet'}`
  ].join('\n');
}
const briefing = evolutionBriefing();

// Each question gets a fresh context so items don't contaminate each other.
async function askOne(question) {
  const messages = [{ role: 'system', content: soul }];
  if (briefing) messages.push({ role: 'system', content: briefing });
  messages.push({ role: 'user', content: `${question}\n\n(Answer briefly, 1-2 sentences, in character.)` });
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, think: false, messages })
  });
  const data = await res.json();
  if (!data.message) throw new Error('Ollama error: ' + JSON.stringify(data));
  return data.message.content.trim();
}

function csvCell(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function main() {
  console.log(`\nSurvey — ${personaName} (${slug}), model: ${MODEL}\n`);
  if (briefing) console.log(briefing + '\n');

  const rows = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    console.log(`Q${i + 1}: ${q}`);
    let answer;
    try {
      answer = await askOne(q);
    } catch (err) {
      answer = 'ERROR: ' + err.message;
    }
    console.log(`A${i + 1}: ${answer}\n`);
    rows.push({ id: i + 1, q, a: answer });
  }

  const outPath = path.resolve(`survey-results-${slug}.csv`);
  const header = 'persona,question_id,question,answer';
  const lines = rows.map(r => [csvCell(slug), r.id, csvCell(r.q), csvCell(r.a)].join(','));
  fs.writeFileSync(outPath, [header, ...lines].join('\n') + '\n');
  console.log(`Saved ${rows.length} responses to ${outPath}`);
}

main();
