import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';

const folder = mkdtempSync(join(tmpdir(), 'board-digest-'));
const filename = join(folder, 'test.sqlite');
let app;
let base;

async function launch() {
  app = createApp(filename).listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = 'http://127.0.0.1:' + app.address().port;
}

async function stop() {
  const stopped = once(app, 'close');
  app.close();
  await stopped;
  app = null;
}

async function call(path, { role = 'comsec', body, status = 200 } = {}) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Demo-Role': role, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, status, response.status !== status ? await response.text() : undefined);
  return response.headers.get('content-type').startsWith('application/json') ? response.json() : response.text();
}

const state = (role) => call('/api/state', { role });
const put = (path, body = {}, role = 'comsec', status = 200) => call('/api/do/' + path, { body, role, status });
const pass = (code, description) => console.log('PASS', code, description);

try {
  await launch();
  assert.match(await call('/'), /The Board Digest/);
  assert.match(await call('/app.js'), /setInterval/);
  assert.match(await call('/style.css'), /\.layout/);

  const m = await put('create-meeting', { board: 'คณะตรวจสอบ (จำลอง)', date: '2027-02-20', time: '10:00' });
  const a = await put('book/' + m.id, { title: 'วาระจำลอง', objective: 'เพื่อพิจารณา' }, 'finance');
  const target = m.id + '/' + a.id;
  await put('confirm/' + target, { order: 1 });
  const inCalendar = (await state('finance')).meetings.find((entry) => entry.id === m.id);
  assert.equal(inCalendar.date, '2027-02-20');
  assert.deepEqual(inCalendar.agendas.map(({ title, order, owner, status }) => ({ title, order, owner, status })), [
    { title: 'วาระจำลอง', order: 1, owner: 'finance', status: 'confirmed' },
  ]);
  pass('AC-01', 'create, book, confirm, calendar');

  const upload = (name) => put('upload/' + target, { name, content: Buffer.from(name).toString('base64') }, 'finance');
  const doc1 = await upload('v1.txt');
  await put('review/' + target, { document: doc1.id, status: 'revision', reason: 'เพิ่มข้อมูล' });
  const doc2 = await upload('v2.txt');
  await put('review/' + target, { document: doc2.id, status: 'accepted' });
  const reviewed = await put('use-document/' + target, { document: doc2.id });
  assert.equal(reviewed.usedDocument, doc2.id);
  assert.deepEqual(reviewed.documents.map(({ number, status }) => [number, status]), [[1, 'revision'], [2, 'accepted']]);
  assert.equal(await call('/api/file/' + doc1.id, { role: 'finance' }), 'v1.txt');
  assert.equal(await call('/api/file/' + doc2.id, { role: 'finance' }), 'v2.txt');
  pass('AC-02', 'file versions, review and version used');

  const first = '2027-02-07T02:00:00Z';
  const second = '2027-02-09T02:00:00Z';
  assert.equal((await put('remind', { at: '2027-02-07T01:59:59Z' })).attempted, 0);
  assert.equal((await put('remind', { at: first })).attempted, 1);
  assert.equal((await put('remind', { at: first })).attempted, 0);
  const moved = await put('reschedule/M-001', { date: '2027-02-12', time: '10:00' });
  assert.equal(moved.history[0].deadline, '2027-02-07T02:00:00.000Z');
  assert.equal(moved.deadline, '2027-02-09T02:00:00.000Z');
  assert.equal((await put('remind', { at: first })).attempted, 0);
  assert.equal((await put('remind', { at: second, fail: true })).attempted, 1);
  const failed = (await state()).reminders.at(-1);
  assert.equal(failed.status, 'failed');
  const concurrentRuns = await Promise.all([put('remind', { at: second }), put('remind', { at: second })]);
  assert.deepEqual(concurrentRuns.map(({ attempted }) => attempted).sort(), [0, 1]);
  const history = (await state()).reminders;
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'sent');
  assert.equal(history[1].key, failed.key);
  assert.deepEqual(history[1].attempts.map(({ status }) => status), ['failed', 'sent']);
  pass('AC-03', 'T−3 boundary, reschedule and concurrent deduplication');

  const ops = await state('operations');
  assert(!ops.meetings.flatMap((entry) => entry.agendas).some((entry) => entry.owner === 'finance'));
  await call('/api/file/' + doc1.id, { role: 'operations', status: 403 });
  assert((await state()).audit.some((entry) => entry.route === '/api/file/' + doc1.id && entry.outcome === 'denied'));
  pass('AC-04', 'role-scoped view data, direct download denial and audit');

  await put('hold/M-001', { attendees: 'ทีมจำลอง' });
  const generated = await put('generate/M-001');
  assert.match(generated.items[0].evidence, /TR-001 00:04:12–00:04:40/);
  assert.match(generated.items[0].pending, /รอ ComSec ยืนยัน/);
  assert.equal(generated.items[0].resolution, '');
  const draft = (await state()).meetings.find((entry) => entry.id === 'M-001').minutes[0];
  const version = 'M-001/' + draft.id;
  await put('save-minutes/' + version, { ...draft.items[0], opinions: 'บันทึกที่ผู้ใช้แก้ไว้' });
  assert.equal((await put('generate/M-001', { fail: true })).status, 'failed');
  assert.equal((await put('generate/M-001')).status, 'ready');
  assert.equal((await state()).meetings.find((entry) => entry.id === 'M-001').minutes[0].items[0].opinions, 'บันทึกที่ผู้ใช้แก้ไว้');
  pass('AC-08', 'notification retry and failed generation preserves saved edits');
  await put('publish/' + version, {}, 'comsec', 409);
  assert.equal((await put('submit/' + version)).status, 'in_review');
  pass('AC-05', 'ambiguous proposal retains evidence and enters review');
  await put('approve/' + version, {}, 'finance', 403);
  assert.equal((await put('approve/' + version)).approvedBy, 'comsec');
  assert.equal((await put('publish/' + version)).status, 'published');
  assert.equal((await put('revise/' + version)).number, 2);
  assert.equal((await state()).meetings.find((entry) => entry.id === 'M-001').minutes[0].status, 'published');
  pass('AC-06', 'publish gate, approver, and immutable previous version');

  const task = await put('create-action/' + version, { agenda: 'A-001', owner: 'finance', task: 'ปรับเอกสารงบประมาณ', due: '2027-02-28' });
  await put('update-action/_/' + task.id, { status: 'in_progress' }, 'finance');
  await put('update-action/_/' + task.id, { status: 'pending_review', proof: 'เอกสารฉบับแก้ไข' }, 'finance');
  assert.equal((await state()).actions[0].status, 'pending_review');
  await put('close-action/_/' + task.id, {}, 'finance', 403);
  await put('close-action/_/' + task.id);
  const observed = (await state('finance')).actions[0];
  assert.equal(observed.status, 'closed');
  assert.equal(observed.closedBy, 'comsec');
  assert(Date.now() - Date.parse(observed.updated) < 60_000);
  assert((await state()).audit.some((entry) => entry.after?.id === task.id && entry.before?.status === 'pending_review' && entry.after.status === 'closed'));
  pass('AC-07', 'owner update, ComSec close, timestamps and audit');

  await stop();
  await launch();
  assert.equal((await state('finance')).actions[0].status, 'closed');
  assert.equal(await call('/api/file/' + doc2.id, { role: 'finance' }), 'v2.txt');
  pass('SQLite', 'records and files survive server restart');
} finally {
  if (app) await stop();
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
  rmdirSync(folder);
}
