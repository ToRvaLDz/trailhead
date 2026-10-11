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
  pendingAskIndex,
  askHasLink,
} = require('./trailhead-mockup-link-guard.js');

const HOOK = path.join(__dirname, 'trailhead-mockup-link-guard.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Costruttori di righe transcript (stesso shape JSONL di Claude Code)
const text = (t) => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: t }] } });
const thinking = () => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'thinking', thinking: '' }] } });
const toolUse = (name, input = {}, id = 'x') => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', id, name, input }] } });
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
      { label: 'Prima un mockup', description: 'Disegno la pagina su un canvas Artifacts e attendo approvazione prima di scriverla' },
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
ok('https URL counts as a link', hasLink('Ecco: https://claude.ai/artifact/AbC123xyz'));
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
  text('Mockup: https://claude.ai/artifact/AbC123xyz'),
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

// Senza ancora: comportamento storico, si parte dalla coda del transcript
const noAnchor = [userPrompt('x'), text('Ecco https://a.b/c')];
ok('without an anchor the prose is read from the transcript tail', hasLink(proseBeforeAsk(noAnchor)));

// Con ancora: si parte dall'ask trovato, non dalla coda
const anchored = [
  userPrompt('x'),
  text('Mockup: https://a.b/c'),
  toolUse('AskUserQuestion', approvalInput, 'ask1'),
  toolResult('Approvo'),
  text('Altro testo senza link'),
];
ok('with an anchor the prose is read back from the anchored ask', hasLink(proseBeforeAsk(anchored, 2)));

// --- askHasLink ---
const askWith = (over) => ({ questions: [{ ...approvalInput.questions[0], ...over }] });
ok('link in the approval question counts', askHasLink(askWith({ question: 'Approvi il mockup https://claude.ai/artifact/AbC123?' })));
ok('link in the approval header counts', askHasLink(askWith({ header: 'https://claude.ai/artifact/AbC123' })));
ok('link in an approval option label counts', askHasLink(askWith({ options: [{ label: 'Apri https://a.b/c' }, { label: 'No' }] })));
ok('link in an approval option description counts', askHasLink(askWith({ options: [{ label: 'Approvo', description: 'vedi mockups/faq.html' }] })));
ok('approval ask without any link has none', !askHasLink(approvalInput));
ok('link only in a different non-approval question does not count', !askHasLink({
  questions: [
    { question: 'Dove sta il piano?', options: [{ label: 'https://a.b/piano' }] },
    approvalInput.questions[0],
  ],
}));
ok('malformed input has no ask link', !askHasLink({}) && !askHasLink(null));

// --- pendingAskIndex ---
const withIds = [userPrompt('x'), toolUse('Bash', {}, 'b1'), toolResult('ok'), text('Prosa'), toolUse('AskUserQuestion', approvalInput, 'ask1')];
ok('pendingAskIndex finds the entry by tool_use id', pendingAskIndex(withIds, 'ask1', approvalInput) === 4);
ok('pendingAskIndex by id ignores a missing id', pendingAskIndex(withIds, 'nope', approvalInput) === -1);
ok('pendingAskIndex without id falls back to input equality on the tail', pendingAskIndex(withIds, undefined, approvalInput) === 4);
ok('pendingAskIndex without id is -1 when the tail ask has a different input',
  pendingAskIndex(withIds, undefined, askWith({ question: 'Approvi il mockup B?' })) === -1);
ok('pendingAskIndex is -1 when the tail is the previous tool_result',
  pendingAskIndex([userPrompt('x'), toolUse('Bash', {}, 'b1'), toolResult('ok')], undefined, approvalInput) === -1);
ok('pendingAskIndex ignores sidechain entries', pendingAskIndex([{ ...toolUse('AskUserQuestion', approvalInput, 'ask1'), isSidechain: true }], 'ask1', approvalInput) === -1);

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

const withLink = [...failing.slice(0, 4), text('Mockup: https://claude.ai/artifact/AbC123xyz'), failing[5]];
const r2 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: writeTranscript(withLink) });
ok('approval ask with a link in the prose is allowed', r2.code === 0 && r2.out.trim() === '');

const r3 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: '/nonexistent/t.jsonl' });
ok('missing transcript fails open', r3.code === 0);

const r4 = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: writeTranscript(failing) });
ok('other tools are ignored', r4.code === 0);

const r5 = runHook({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Approvi il piano?', options: [] }] }, transcript_path: writeTranscript(failing) });
ok('non-mockup ask is allowed', r5.code === 0);

// Shape reale di Claude Code 2.1.295: il messaggio corrente non e' ancora nel transcript
const unflushed = [userPrompt('lavora #12'), toolUse('Bash', {}, 'b1'), toolResult('ok')];
const ra = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: approvalInput, transcript_path: writeTranscript(unflushed) });
ok('(a) transcript ending at a previous tool_result fails open', ra.code === 0 && ra.out.trim() === '');

const flushedNoLink = [...failing.slice(0, 5), toolUse('AskUserQuestion', approvalInput, 'ask1')];
const rb = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: approvalInput, transcript_path: writeTranscript(flushedNoLink) });
ok('(b) tool_use_id with the ask entry present and no link in the prose is blocked', rb.code === 2 && /MOCKUP_LINK_MISSING/.test(rb.out));

const linkedAsk = askWith({ question: 'Approvi il mockup https://claude.ai/artifact/AbC123?' });
const rc = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: linkedAsk, transcript_path: writeTranscript(failing) });
ok('(c) link carried by the ask question is allowed', rc.code === 0 && rc.out.trim() === '');

const otherPending = [userPrompt('x'), text('Niente link'), toolUse('AskUserQuestion', { questions: [{ question: 'Altro?', options: [] }] }, 'other')];
const rd = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: approvalInput, transcript_path: writeTranscript(otherPending) });
ok('(d) transcript ending in a different pending ask fails open', rd.code === 0 && rd.out.trim() === '');

// Testo e tool_use nella STESSA riga di transcript
const sameEntry = (t) => ({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: t }, { type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: approvalInput }] } });
ok('text before the tool_use in the same entry counts as prose', hasLink(proseBeforeAsk([userPrompt('x'), sameEntry('Vedi https://a.b/c')], 1)));
ok('same-entry text is also read from the tail', hasLink(proseBeforeAsk([userPrompt('x'), sameEntry('Vedi https://a.b/c')])));
const rs1 = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: approvalInput, transcript_path: writeTranscript([userPrompt('x'), sameEntry('Vedi https://a.b/c')]) });
ok('same-entry text with a link is allowed', rs1.code === 0 && rs1.out.trim() === '');
const rs2 = runHook({ tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: approvalInput, transcript_path: writeTranscript([userPrompt('x'), sameEntry('Mockup pronto su MyApp')]) });
ok('same-entry text without a link is blocked', rs2.code === 2 && /MOCKUP_LINK_MISSING/.test(rs2.out));

// Senza tool_use_id: ask in coda identico a tool_input (fallback per uguaglianza)
const ri1 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: writeTranscript(flushedNoLink) });
ok('no id, identical tail ask, no link in the prose is blocked', ri1.code === 2 && /MOCKUP_LINK_MISSING/.test(ri1.out));
const flushedLink = [...failing.slice(0, 4), text('Mockup: https://claude.ai/artifact/AbC123xyz'), toolUse('AskUserQuestion', approvalInput, 'ask1')];
const ri2 = runHook({ tool_name: 'AskUserQuestion', tool_input: approvalInput, transcript_path: writeTranscript(flushedLink) });
ok('no id, identical tail ask, link in the prose is allowed', ri2.code === 0 && ri2.out.trim() === '');

let r6;
try { execFileSync('node', [HOOK], { input: 'not json' }); r6 = 0; } catch (e) { r6 = e.status; }
ok('unparseable input fails open', r6 === 0);

console.log(`trailhead-mockup-link-guard: ${passed} passed`);
