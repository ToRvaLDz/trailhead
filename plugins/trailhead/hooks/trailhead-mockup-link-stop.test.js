#!/usr/bin/env node
// Tests for trailhead-mockup-link-stop.js (+ lib/mockup-link.js message detection).
// Run: node trailhead-mockup-link-stop.test.js
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { isMockupApprovalMessage } = require('./lib/mockup-link.js');

const HOOK = path.join(__dirname, 'trailhead-mockup-link-stop.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Risposta Codex: la domanda è un elenco numerato in testo semplice
const noLink = [
  'Il mockup della pagina FAQ è pronto su MyApp, con indice sezioni.',
  '',
  'Approvi il mockup della pagina FAQ?',
  '1. Approvo',
  '2. Chiedo modifiche',
].join('\n');
const withLink = noLink.replace('pronto su MyApp', 'pronto: https://claude.ai/artifact/AbC123xyz');

// --- isMockupApprovalMessage ---
ok('IT approval reply is detected', isMockupApprovalMessage(noLink));
ok('EN approval reply is detected', isMockupApprovalMessage('Mockup ready.\n\nDo you approve the login mockup?\n1. Yes\n2. No'));
ok('variant pick is detected', isMockupApprovalMessage('Due prototipi pronti.\nQuale variante scegli?\n1. A\n2. B'));
ok('past approval mention is NOT an ask', !isMockupApprovalMessage('Ho implementato il mockup approvato. Commit fatto.'));
ok('approval word without a question line is NOT an ask', !isMockupApprovalMessage('Approvi il mockup quando vuoi.'));
ok('"want mockups first?" offer is NOT an ask', !isMockupApprovalMessage('Vuoi prima un mockup?\n1. Sì\n2. No'));
ok('non-string is not detected', !isMockupApprovalMessage(undefined));

// --- end-to-end ---
function runHook(payload) {
  try {
    const out = execFileSync('node', [HOOK], { input: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '').toString() };
  }
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const r1 = runHook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: noLink });
const j1 = parse(r1.out);
ok('approval reply without a link: continues the turn with a block decision (exit 0, JSON)',
  r1.code === 0 && j1 && j1.decision === 'block' && /mockup-link/.test(j1.reason));

const r2 = runHook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: withLink });
ok('approval reply with a link is allowed', r2.code === 0 && r2.out.trim() === '');

const r3 = runHook({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: noLink });
ok('already-continued turn is never blocked again (no loop)', r3.code === 0 && r3.out.trim() === '');

const r4 = runHook({ hook_event_name: 'Stop', stop_hook_active: false });
ok('missing last_assistant_message fails open', r4.code === 0 && r4.out.trim() === '');

const r5 = runHook({ hook_event_name: 'Stop', last_assistant_message: 'Fatto, commit pushato.' });
ok('ordinary reply is allowed', r5.code === 0 && r5.out.trim() === '');

const r6 = runHook('not json');
ok('unparseable input fails open', r6.code === 0 && r6.out.trim() === '');

console.log(`trailhead-mockup-link-stop: ${passed} passed`);
