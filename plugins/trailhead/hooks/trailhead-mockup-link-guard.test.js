#!/usr/bin/env node
// Tests for trailhead-mockup-link-guard.js. Run: node trailhead-mockup-link-guard.test.js
// No framework: plain asserts + child_process for the end-to-end hook behaviour.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  isMockupApprovalAsk,
  hasLink,
  proseBeforeAsk,
} = require('./trailhead-mockup-link-guard.js');

const HOOK = path.join(__dirname, 'trailhead-mockup-link-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Costruttori di righe transcript (stesso shape JSONL di Claude Code)
const text = (t) => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: t }] } });
const thinking = () => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'thinking', thinking: '' }] } });
const toolUse = (name, input = {}) => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });
const toolResult = (c) => ({ type: 'user', isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: c }] } });
const userPrompt = (c) => ({ type: 'user', isSidechain: false, message: { content: c } });

const approvalInput = {
  questions: [{
    question: 'Approvi il mockup della pagina FAQ?',
    header: 'Mockup',
    multiSelect: false,
    options: [{ label: 'Approvo', description: 'Procedi col codice UI' }, { label: 'Chiedo modifiche', description: '' }],
  }],
};

// --- isMockupApprovalAsk ---
ok('IT mockup approval ask is detected', isMockupApprovalAsk(approvalInput));
ok('EN mockup approval ask is detected', isMockupApprovalAsk({
  questions: [{ question: 'Do you approve the login mockup?', options: [{ label: 'Approve' }, { label: 'Request changes' }] }],
}));
ok('pick between prototype variants is detected', isMockupApprovalAsk({
  questions: [{ question: 'Quale variante del prototipo scegli?', options: [{ label: 'Variante A' }, { label: 'Variante B' }] }],
}));
ok('"want mockups first?" offer is NOT an approval ask', !isMockupApprovalAsk({
  questions: [{ question: 'Vuoi prima un mockup della schermata?', options: [{ label: 'Sì' }, { label: 'No' }] }],
}));
// Regressione da una sessione reale: l'offerta di un mockup cita una
// approvazione futura solo nella descrizione dell'opzione
ok('mockup offer whose option description mentions approval is NOT an approval ask', !isMockupApprovalAsk({
  questions: [{
    question: 'Vuoi cambiare qualcosa nello scope della pagina FAQ?',
    header: 'Scope',
    options: [
      { label: 'Va bene così', description: 'Procedo con lo scope descritto' },
      { label: 'Prima un mockup', description: 'Disegno la pagina su claude.ai/design e attendo approvazione prima di scriverla' },
    ],
  }],
}));
ok('mockup and approval words in different questions do not combine', !isMockupApprovalAsk({
  questions: [
    { question: 'Vuoi prima un mockup?', options: [{ label: 'Sì' }] },
    { question: 'Approvi il piano?', options: [{ label: 'Sì' }] },
  ],
}));
ok('unrelated ask is not detected', !isMockupApprovalAsk({
  questions: [{ question: 'Approvi il piano?', options: [{ label: 'Sì' }, { label: 'No' }] }],
}));
ok('malformed input is not detected', !isMockupApprovalAsk({}) && !isMockupApprovalAsk(null));

// --- hasLink ---
ok('https URL counts as a link', hasLink('Ecco: https://claude.ai/design/p/abc?file=faq.html'));
ok('absolute html path counts as a link', hasLink('Mockup in /home/u/app/mockups/faq.html'));
ok('relative html path counts as a link', hasLink('apri `mockups/faq.html`'));
ok('markdown link to a file counts', hasLink('[faq](mockups/faq.html)'));
ok('project name alone is NOT a link', !hasLink('Il mockup della pagina FAQ è pronto su MyApp, gruppo Marketing.'));
ok('empty prose has no link', !hasLink(''));

// --- proseBeforeAsk ---
const failing = [
  userPrompt('lavora #12'),
  toolUse('Bash'),
  toolResult('ok'),
  thinking(),
  text('Il mockup della pagina FAQ è pronto su MyApp, con indice sezioni.'),
  toolUse('AskUserQuestion', approvalInput),
];
ok('prose right before the ask is collected', /pronto su MyApp/.test(proseBeforeAsk(failing)));

const linkBeforeTools = [
  userPrompt('lavora #12'),
  text('Mockup: https://claude.ai/design/p/abc'),
  toolUse('Bash'),
  toolResult('ok'),
  text('Pronto.'),
  toolUse('AskUserQuestion', approvalInput),
];
ok('a link before an intervening tool call does not count', !hasLink(proseBeforeAsk(linkBeforeTools)));

const sidechain = [
  text('Mockup FAQ pronto.'),
  { ...text('https://example.com/side'), isSidechain: true },
  toolUse('AskUserQuestion', approvalInput),
];
ok('sidechain text is ignored', !hasLink(proseBeforeAsk(sidechain)));

const noAskYet = [userPrompt('x'), text('Ecco https://a.b/c')];
ok('works when the pending tool_use is not yet in the transcript', hasLink(proseBeforeAsk(noAskYet)));

// --- end-to-end ---
function writeTranscript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-mlg-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
}
function runHook(payload) {
  try {
    const out = execFileSync('node', [HOOK], { input: JSON.stringify(payload) });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString() };
  }
}

const r1 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: writeTranscript(failing) });
ok('approval ask without a link in the prose is blocked (exit 2)', r1.code === 2 && /MOCKUP_LINK_MISSING/.test(r1.out));

const withLink = [...failing.slice(0, 4), text('Mockup: https://claude.ai/design/p/abc?file=faq.html'), failing[5]];
const r2 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: writeTranscript(withLink) });
ok('approval ask with a link in the prose is allowed', r2.code === 0 && r2.out.trim() === '');

const r3 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: '/nonexistent/t.jsonl' });
ok('missing transcript fails open', r3.code === 0);

const r4 = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: writeTranscript(failing) });
ok('other tools are ignored', r4.code === 0);

const r5 = runHook({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Approvi il piano?', options: [] }] }, transcript_path: writeTranscript(failing) });
ok('non-mockup ask is allowed', r5.code === 0);

let r6;
try { execFileSync('node', [HOOK], { input: 'not json' }); r6 = 0; } catch (e) { r6 = e.status; }
ok('unparseable input fails open', r6 === 0);

console.log(`trailhead-mockup-link-guard: ${passed} passed`);
