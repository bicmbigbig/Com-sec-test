import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const roles = new Set(['comsec', 'finance', 'operations']);
const asText = (value) => typeof value === 'string' ? value.trim() : '';
const id = () => randomUUID();
const now = () => new Date().toISOString();
const bangkok = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const presentationLimit = 20 * 1024 * 1024;
const bundledPython = resolve(process.execPath, '../../..', 'python', 'python.exe');
const python = process.env.BOARD_DIGEST_PYTHON || (existsSync(bundledPython) ? bundledPython : process.platform === 'win32' ? 'python' : 'python3');
const narrativeCommands = new Set(['upload-presentation', 'prepare-presentation', 'confirm-concepts', 'draft-narration']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireThat(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

function required(value, message) {
  const result = asText(value);
  requireThat(result, message);
  return result;
}

function dateOnly(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'วันที่ไม่ถูกต้อง');
  const parsed = new Date(value + 'T00:00:00Z');
  requireThat(!isNaN(parsed) && parsed.toISOString().slice(0, 10) === value, 'วันที่ไม่ถูกต้อง');
  return parsed;
}

function deadline(date, time) {
  const day = dateOnly(date);
  requireThat(typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time), 'เวลาไม่ถูกต้อง');
  day.setUTCDate(day.getUTCDate() - 3);
  return new Date(day.toISOString().slice(0, 10) + 'T' + time + ':00+07:00').toISOString();
}

function sample() {
  return {
    meetings: [{
      id: 'M-001', board: 'คณะกรรมการบริษัท', date: '2027-02-10', time: '10:00', reminderTime: '09:00',
      deadline: deadline('2027-02-10', '09:00'), history: [], status: 'planned', attendees: '',
      transcript: [
        { source: 'TR-001', agenda: 'A-001', timestamp: '00:04:12–00:04:40', text: 'ฝ่ายการเงินเสนอกรอบงบประมาณปี 2570 เพื่อพิจารณา' },
        { source: 'TR-001', agenda: 'A-002', timestamp: '00:12:10–00:13:05', text: 'ฝ่ายปฏิบัติการรายงานความคืบหน้าโครงการปรับปรุงระบบ' },
      ],
      agendas: [
        { id: 'A-001', title: 'กรอบงบประมาณปี 2570', owner: 'finance', objective: 'เพื่อพิจารณา', proposal: 'พิจารณากรอบงบประมาณประจำปี', authority: 'DOA-01 ฉบับ 2', order: 1, status: 'confirmed', documents: [
          { id: 'D-001', number: 1, name: 'budget-v1.txt', by: 'finance', at: '2027-02-01T03:00:00Z', status: 'revision', reason: 'ขอแยกรายการลงทุน' },
          { id: 'D-002', number: 2, name: 'budget-v2.txt', by: 'finance', at: '2027-02-04T03:00:00Z', status: 'accepted', reason: '' },
        ], usedDocument: null },
        { id: 'A-002', title: 'ความคืบหน้าโครงการปรับปรุงระบบ', owner: 'operations', objective: 'เพื่อทราบ', proposal: '', authority: '', order: 2, status: 'confirmed', documents: [], usedDocument: null },
      ],
      minutes: [], generation: null,
    }],
    actions: [], reminders: [], audit: [],
  };
}

function find(list, key) {
  const item = list.find((entry) => entry.id === key);
  requireThat(item, 'ไม่พบรายการ', 404);
  return item;
}

function latest(list) {
  return list.at(-1);
}

function stage(item, destination, allowed) {
  requireThat(allowed.includes(item.status), 'สถานะปัจจุบันไม่รองรับการดำเนินการนี้', 409);
  item.status = destination;
}

function minutesDraft(meeting, items) {
  requireThat(!['draft', 'in_review'].includes(latest(meeting.minutes)?.status), 'มีร่างที่ยังดำเนินการอยู่', 409);
  const version = { id: id(), number: meeting.minutes.length + 1, status: 'draft', items, updated: now() };
  meeting.minutes.push(version);
  return version;
}

function emptyItems(meeting) {
  return meeting.agendas.filter((agenda) => agenda.status === 'held').map((agenda) => ({
    agenda: agenda.id, summary: '', opinions: '', resolution: '', evidence: '', pending: '',
  }));
}

function audit(state, role, route, outcome, before = null, after = null) {
  state.audit.unshift({ role, route, outcome, before, after, at: now() });
}

function stateFor(state, role) {
  if (role === 'comsec') return state;
  return {
    meetings: state.meetings.map(({ id, board, date, time, deadline, status, agendas }) => ({
      id, board, date, time, deadline, status, agendas: agendas.filter((agenda) => agenda.owner === role),
    })),
    actions: state.actions.filter((action) => action.owner === role),
  };
}

function filePayload(body, limit = 2 * 1024 * 1024) {
  const name = required(body.name, 'กรุณาเลือกไฟล์').slice(0, 160);
  const encoded = required(body.content, 'ไฟล์ว่างหรืออ่านไม่ได้');
  requireThat(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 === 0, 'รูปแบบไฟล์ไม่ถูกต้อง');
  const bytes = Buffer.from(encoded, 'base64');
  requireThat(bytes.length && bytes.length <= limit, 'ขนาดไฟล์สูงสุด ' + limit / (1024 * 1024) + ' MB');
  return { name, bytes };
}

function office(operation, input) {
  const result = spawnSync(python, [resolve(root, 'office.py'), operation], {
    input, maxBuffer: 2 * 1024 * 1024, timeout: 15_000, windowsHide: true,
  });
  if (result.error) {
    console.error('Office helper:', result.error.message);
    throw new HttpError(503, 'เปิดเครื่องมือ PowerPoint และ Word ไม่สำเร็จ กรุณาตรวจการตั้งค่า Python');
  }
  requireThat(result.status === 0, result.stderr.toString('utf8').trim() || 'ประมวลผลไฟล์ไม่สำเร็จ', 422);
  return result.stdout;
}

function readPresentation(filename, bytes) {
  requireThat(/\.pptx$/i.test(filename), 'กรุณาเลือกไฟล์ PowerPoint .pptx', 422);
  return JSON.parse(office('slides', bytes));
}

function savePresentation(agenda, document, slides, at) {
  const review = { document: document.id, slides, revision: 1, status: 'prepared', updated: at };
  (agenda.narratives ??= {})[document.id] = review;
  return review;
}

function changeNarrative({ command, meeting, agenda, body, role, at, db }) {
  requireThat(agenda.owner === role, 'สิทธิ์นี้สำหรับเจ้าของวาระ', 403);
  if (command === 'upload-presentation') {
    requireThat(meeting.status === 'planned' && ['booked', 'confirmed'].includes(agenda.status), 'วาระนี้ปิดรับเอกสารแล้ว', 409);
    const { name, bytes } = filePayload(body, presentationLimit);
    const slides = readPresentation(name, bytes);
    const document = { id: id(), number: agenda.documents.length + 1, by: role, at, name, status: 'submitted', reason: '' };
    db.prepare('INSERT INTO files VALUES (?, ?)').run(document.id, bytes);
    agenda.documents.push(document);
    return savePresentation(agenda, document, slides, at);
  }
  const document = find(agenda.documents, body.document);
  const review = agenda.narratives?.[document.id];
  if (command === 'prepare-presentation') {
    if (review) return review;
    const file = db.prepare('SELECT bytes FROM files WHERE id=?').get(document.id);
    requireThat(file, 'ไม่พบไฟล์', 404);
    return savePresentation(agenda, document, readPresentation(document.name, file.bytes), at);
  }
  requireThat(review, 'กรุณาอ่านสไลด์ก่อนยืนยันประเด็น', 409);
  requireThat(body.revision === review.revision, 'มีการแก้ไขจากอีกหน้าจอ กรุณาเปิดข้อมูลล่าสุดแล้วลองใหม่', 409);
  if (command === 'confirm-concepts') {
    requireThat(Array.isArray(body.concepts) && body.concepts.length && body.concepts.length <= review.slides.length, 'กรุณาเลือกและยืนยันอย่างน้อยหนึ่งประเด็น');
    const seen = new Set();
    const concepts = body.concepts.map((item) => {
      const slide = review.slides.find((entry) => entry.number === item?.slide);
      requireThat(slide?.paragraphs.length && !seen.has(item.slide), 'รายการสไลด์ที่ยืนยันไม่ถูกต้อง');
      seen.add(item.slide);
      const concept = required(item.concept, 'กรุณาระบุข้อความประเด็นหลักสำหรับสไลด์ที่เลือก');
      const keywords = asText(item.keywords);
      requireThat(concept.length <= 1800 && keywords.length <= 220, 'ประเด็นหรือคำสำคัญยาวเกินกำหนด');
      return { slide: item.slide, concept, keywords };
    }).sort((a, b) => a.slide - b.slide);
    Object.assign(review, { concepts, status: 'concepts_confirmed', confirmedAt: at, confirmedBy: role });
    delete review.paragraphs;
  } else {
    requireThat(review.status === 'concepts_confirmed', 'กรุณายืนยันประเด็นก่อนสร้างร่าง', 409);
    review.paragraphs = review.concepts.map(({ slide, concept, keywords }) => ({
      slide, text: concept.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' '), keywords,
    }));
    review.status = 'narration_ready';
  }
  review.revision++;
  review.updated = at;
  return review;
}

function move({ parts, body, state, role, at, db }) {
  const [command, meetingId, targetId] = parts;
  const comsec = () => requireThat(role === 'comsec', 'สิทธิ์นี้สำหรับ ComSec', 403);
  if (command === 'remind') {
    comsec();
    const simulated = body.at ? new Date(body.at) : new Date(at);
    requireThat(!isNaN(simulated), 'วันเวลาในการทดสอบไม่ถูกต้อง');
    let attempted = 0;
    for (const meeting of state.meetings) {
      if (meeting.status !== 'planned' || simulated < new Date(meeting.deadline)) continue;
      for (const agenda of meeting.agendas) {
        if (agenda.status !== 'confirmed' || latest(agenda.documents)?.status === 'accepted') continue;
        const key = [agenda.id, 't-3', meeting.deadline].join('/');
        let reminder = state.reminders.find((entry) => entry.key === key);
        if (reminder?.status === 'sent') continue;
        if (!reminder) {
          reminder = { key, meeting: meeting.id, agenda: agenda.id, due: meeting.deadline, attempts: [] };
          state.reminders.push(reminder);
        }
        reminder.status = body.fail === true ? 'failed' : 'sent';
        reminder.attempts.push({ at: simulated.toISOString(), status: reminder.status });
        attempted++;
      }
    }
    return { attempted };
  }
  if (command === 'create-meeting') {
    comsec();
    const board = required(body.board, 'กรุณาระบุชื่อคณะ');
    const reminderTime = body.reminderTime || '09:00';
    deadline(body.date, body.time);
    const meeting = {
      id: id(), board, date: body.date, time: body.time, reminderTime, status: 'planned',
      deadline: deadline(body.date, reminderTime), history: [], attendees: '', transcript: [], agendas: [],
      minutes: [], generation: null,
    };
    state.meetings.push(meeting);
    return meeting;
  }
  if (command === 'update-action' || command === 'close-action') {
    const action = find(state.actions, targetId);
    requireThat(role === 'comsec' || action.owner === role, 'ไม่มีสิทธิ์เข้าถึงงานนี้', 403);
    if (command === 'close-action') {
      comsec();
      stage(action, 'closed', ['pending_review']);
      action.closedBy = role;
    } else {
      requireThat(action.owner === role, 'สิทธิ์นี้สำหรับเจ้าของงาน', 403);
      if (body.status === 'in_progress') stage(action, body.status, ['open', 'in_progress']);
      else {
        requireThat(body.status === 'pending_review', 'สถานะงานไม่ถูกต้อง');
        const proof = required(body.proof, 'กรุณาระบุหลักฐานปิดงาน');
        stage(action, body.status, ['open', 'in_progress']);
        action.proof = proof;
      }
    }
    action.updated = at;
    return action;
  }
  const meeting = find(state.meetings, meetingId);
  switch (command) {
    case 'reschedule': {
      comsec();
      requireThat(meeting.status === 'planned', 'เลื่อนวันได้เฉพาะนัดที่ยังไม่จัดประชุม', 409);
      deadline(body.date, body.time);
      const reminderTime = body.reminderTime || meeting.reminderTime;
      const nextDeadline = deadline(body.date, reminderTime);
      if (meeting.date !== body.date || meeting.time !== body.time || meeting.deadline !== nextDeadline) {
        meeting.history.push({ date: meeting.date, time: meeting.time, deadline: meeting.deadline, at });
        Object.assign(meeting, { date: body.date, time: body.time, reminderTime, deadline: nextDeadline });
      }
      return meeting;
    }
    case 'book': {
      requireThat(meeting.status === 'planned', 'ปิดรับวาระแล้ว', 409);
      const owner = role === 'comsec' ? body.owner : role;
      requireThat(roles.has(owner) && owner !== 'comsec', 'กรุณาเลือกเจ้าของวาระ');
      const agenda = {
        id: id(), title: required(body.title, 'กรุณาระบุชื่อวาระ'), owner,
        objective: required(body.objective, 'กรุณาระบุวัตถุประสงค์'), proposal: asText(body.proposal),
        authority: asText(body.authority), status: 'booked', order: null, documents: [], usedDocument: null,
      };
      meeting.agendas.push(agenda);
      return agenda;
    }
    case 'hold':
      comsec();
      requireThat(meeting.agendas.some((agenda) => agenda.status === 'confirmed'), 'กรุณายืนยันวาระก่อนจัดประชุม', 409);
      requireThat(!meeting.agendas.some((agenda) => agenda.status === 'booked'), 'กรุณายืนยันหรือยกเลิกวาระที่จองไว้', 409);
      stage(meeting, 'held', ['planned']);
      meeting.attendees = asText(body.attendees);
      for (const agenda of meeting.agendas.filter((entry) => entry.status === 'confirmed')) agenda.status = 'held';
      return meeting;
    case 'transcript': {
      comsec();
      const agenda = find(meeting.agendas, targetId);
      requireThat(['confirmed', 'held'].includes(agenda.status), 'วาระยังไม่พร้อมบันทึก transcript', 409);
      const timestamp = required(body.timestamp, 'กรุณาระบุช่วงเวลา');
      requireThat(/^\d{2}:[0-5]\d:[0-5]\d[–-]\d{2}:[0-5]\d:[0-5]\d$/.test(timestamp), 'ใช้รูปแบบ 00:04:12–00:04:40');
      const entry = { source: required(body.source, 'กรุณาระบุรหัส transcript'), agenda: agenda.id, timestamp, text: required(body.text, 'กรุณาระบุข้อความ') };
      meeting.transcript.push(entry);
      return entry;
    }
    case 'draft':
      comsec();
      requireThat(meeting.status === 'held', 'กรุณาบันทึกการจัดประชุมก่อน', 409);
      return minutesDraft(meeting, emptyItems(meeting));
    case 'revise': {
      comsec();
      const previous = find(meeting.minutes, targetId);
      requireThat(['approved', 'published'].includes(previous.status), 'สร้างฉบับแก้ไขได้จากรายงานที่รับรองแล้ว', 409);
      return minutesDraft(meeting, structuredClone(previous.items));
    }
    case 'generate': {
      comsec();
      requireThat(meeting.status === 'held', 'กรุณาบันทึกการจัดประชุมก่อน', 409);
      const current = latest(meeting.minutes);
      if (body.fail === true || !meeting.transcript.length) {
        meeting.generation = { status: 'failed', at, reason: body.fail === true ? 'จำลองการร่างล้มเหลว' : 'ยังไม่มี transcript' };
        return meeting.generation;
      }
      requireThat(current?.status !== 'in_review', 'รายงานอยู่ระหว่างตรวจ', 409);
      const items = emptyItems(meeting).map((item) => {
        const sources = meeting.transcript.filter((entry) => entry.agenda === item.agenda);
        if (!sources.length) return { ...item, pending: 'รอ ComSec ยืนยันและแนบหลักฐานของวาระนี้' };
        return {
          ...item, summary: sources.map((entry) => entry.text).join('\n'),
          evidence: sources.map((entry) => entry.source + ' ' + entry.timestamp).join('\n'),
          pending: 'รอ ComSec ยืนยันความเห็น มติ และวันครบกำหนดจากหลักฐานที่ระบุ',
        };
      });
      meeting.generation = { status: 'ready', at, items };
      if (current?.status !== 'draft') minutesDraft(meeting, items);
      return meeting.generation;
    }
    case 'save-minutes':
    case 'submit':
    case 'approve':
    case 'publish': {
      comsec();
      const version = find(meeting.minutes, targetId);
      if (command === 'save-minutes') {
        requireThat(version.status === 'draft', 'แก้ไขได้เฉพาะฉบับร่าง', 409);
        const item = version.items.find((entry) => entry.agenda === body.agenda);
        requireThat(item, 'ไม่พบวาระในรายงาน', 404);
        for (const field of ['summary', 'opinions', 'resolution', 'evidence', 'pending']) item[field] = asText(body[field]);
      }
      if (command === 'submit') stage(version, 'in_review', ['draft']);
      if (command === 'approve') {
        stage(version, 'approved', ['in_review']);
        Object.assign(version, { approvedBy: role, approvedAt: at });
      }
      if (command === 'publish') {
        stage(version, 'published', ['approved']);
        Object.assign(version, { publishedBy: role, publishedAt: at });
      }
      version.updated = at;
      return version;
    }
    case 'create-action': {
      comsec();
      const version = find(meeting.minutes, targetId);
      requireThat(['approved', 'published'].includes(version.status), 'กรุณารับรองรายงานก่อนสร้างงานติดตาม', 409);
      requireThat(version.items.some((entry) => entry.agenda === body.agenda), 'ไม่พบวาระในรายงาน');
      requireThat(roles.has(body.owner) && body.owner !== 'comsec', 'กรุณาเลือกเจ้าของงาน');
      dateOnly(body.due);
      const action = {
        id: id(), meeting: meeting.id, agenda: body.agenda, minutes: version.id, owner: body.owner,
        task: required(body.task, 'กรุณาระบุงาน'), due: body.due, status: 'open', updated: at,
      };
      state.actions.push(action);
      return action;
    }
    default:
      break;
  }

  requireThat(narrativeCommands.has(command) || ['confirm', 'cancel', 'upload', 'review', 'use-document'].includes(command), 'ไม่พบคำสั่ง', 404);
  const agenda = find(meeting.agendas, targetId);
  requireThat(role === 'comsec' || agenda.owner === role, 'ไม่มีสิทธิ์เข้าถึงวาระนี้', 403);
  if (narrativeCommands.has(command)) return changeNarrative({ command, meeting, agenda, body, role, at, db });
  if (command === 'confirm' || command === 'cancel') {
    comsec();
    requireThat(meeting.status === 'planned', 'นัดนี้ปิดรับวาระแล้ว', 409);
    if (command === 'cancel') stage(agenda, 'cancelled', ['booked', 'confirmed']);
    else {
      const order = Number(body.order);
      requireThat(Number.isSafeInteger(order) && order > 0, 'ลำดับต้องเป็นจำนวนเต็มบวก');
      requireThat(!meeting.agendas.some((entry) => entry !== agenda && entry.status === 'confirmed' && entry.order === order), 'ลำดับนี้ถูกใช้แล้ว', 409);
      stage(agenda, 'confirmed', ['booked', 'confirmed']);
      agenda.order = order;
    }
    return agenda;
  }
  if (command === 'upload') {
    requireThat(role === agenda.owner, 'สิทธิ์นี้สำหรับเจ้าของวาระ', 403);
    requireThat(meeting.status === 'planned' && ['booked', 'confirmed'].includes(agenda.status), 'วาระนี้ปิดรับเอกสารแล้ว', 409);
    const { name, bytes } = filePayload(body);
    const document = { id: id(), number: agenda.documents.length + 1, by: role, at, name, status: 'submitted', reason: '' };
    db.prepare('INSERT INTO files VALUES (?, ?)').run(document.id, bytes);
    agenda.documents.push(document);
    return document;
  }
  comsec();
  const document = find(agenda.documents, body.document);
  if (command === 'review') {
    requireThat(meeting.status === 'planned' && document === latest(agenda.documents), 'ตรวจได้เฉพาะฉบับล่าสุดก่อนจัดประชุม', 409);
    requireThat(['accepted', 'revision'].includes(body.status), 'ผลตรวจไม่ถูกต้อง');
    const reason = body.status === 'revision' ? required(body.reason, 'กรุณาระบุเหตุผลที่ขอแก้ไข') : '';
    stage(document, body.status, ['submitted']);
    Object.assign(document, { reason, reviewedBy: role, reviewedAt: at });
  } else {
    requireThat(meeting.status === 'planned' && agenda.status === 'confirmed' && document.status === 'accepted', 'กรุณาเลือกฉบับที่ตรวจรับแล้วของวาระที่ยืนยัน', 409);
    agenda.usedDocument = document.id;
  }
  return agenda;
}

async function jsonBody(request, limit = 3 * 1024 * 1024) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    requireThat(length <= limit, 'ข้อมูลที่ส่งมีขนาดเกินกำหนด', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requireThat(body && typeof body === 'object' && !Array.isArray(body), 'ข้อมูลไม่ถูกต้อง');
    return body;
  } catch {
    throw new HttpError(400, 'ข้อมูล JSON ไม่ถูกต้อง');
  }
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
]);

function send(response, status, data, type = 'application/json', extra = {}) {
  response.writeHead(status, { 'Content-Type': type + (Buffer.isBuffer(data) ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  response.end(type === 'application/json' ? JSON.stringify(data) : data);
}

export function createApp(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE IF NOT EXISTS model (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)');
  if (!db.prepare('SELECT id FROM model WHERE id=1').get()) {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO model VALUES (1, ?)').run(JSON.stringify(sample()));
      const add = db.prepare('INSERT INTO files VALUES (?, ?)');
      add.run('D-001', Buffer.from('เอกสารจำลอง: กรอบงบประมาณ ฉบับแรก'));
      add.run('D-002', Buffer.from('เอกสารจำลอง: กรอบงบประมาณ ฉบับปรับปรุง แยกรายการลงทุน'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const read = () => JSON.parse(db.prepare('SELECT json FROM model WHERE id=1').get().json);
  const write = (state) => db.prepare('UPDATE model SET json=? WHERE id=1').run(JSON.stringify(state));
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const role = request.headers['x-demo-role'];
    try {
      if (request.method === 'GET' && staticFiles.has(pathname)) {
        const [file, type] = staticFiles.get(pathname);
        return send(response, 200, readFileSync(resolve(root, file)), type + '; charset=utf-8');
      }
      requireThat(roles.has(role), 'กรุณาเลือกบทบาททดลอง', 403);
      if (request.method === 'GET' && pathname === '/api/state') {
        return send(response, 200, { ...stateFor(read(), role), today: bangkok.format(new Date()), serverTime: now() });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/narration/')) {
        const state = read();
        const [, , , meetingId, agendaId, docId] = pathname.split('/');
        const meeting = find(state.meetings, meetingId);
        const agenda = find(meeting.agendas, agendaId);
        requireThat(role === 'comsec' || agenda.owner === role, 'ไม่มีสิทธิ์เปิดร่างนี้', 403);
        const document = find(agenda.documents, docId);
        const review = agenda.narratives?.[docId];
        requireThat(review?.status === 'narration_ready', 'กรุณายืนยันประเด็นและสร้างร่างก่อนดาวน์โหลด', 409);
        const data = { title: agenda.title, board: meeting.board, filename: document.name, version: document.number, paragraphs: review.paragraphs };
        return send(response, 200, office('word', Buffer.from(JSON.stringify(data))), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
          'Content-Disposition': 'attachment; filename="agenda-narration.docx"',
        });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/file/')) {
        const state = read();
        const fileId = pathname.split('/').at(-1);
        const agenda = state.meetings.flatMap((meeting) => meeting.agendas).find((entry) => entry.documents.some((doc) => doc.id === fileId));
        requireThat(agenda, 'ไม่พบไฟล์', 404);
        requireThat(role === 'comsec' || agenda.owner === role, 'ไม่มีสิทธิ์เปิดไฟล์นี้', 403);
        const doc = find(agenda.documents, fileId);
        const file = db.prepare('SELECT bytes FROM files WHERE id=?').get(doc.id);
        requireThat(file, 'ไม่พบไฟล์', 404);
        return send(response, 200, Buffer.from(file.bytes), 'application/octet-stream', { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(doc.name).replace(/'/g, '%27') });
      }
      requireThat(request.method === 'POST' && pathname.startsWith('/api/do/'), 'ไม่พบเส้นทาง', 404);
      const parts = pathname.slice('/api/do/'.length).split('/');
      const body = await jsonBody(request, parts[0] === 'upload-presentation' ? 28 * 1024 * 1024 : undefined);
      db.exec('BEGIN IMMEDIATE');
      try {
        const state = read();
        const [command, meetingId, targetId] = parts;
        const meeting = state.meetings.find((entry) => entry.id === meetingId);
        const before = ['close-action', 'update-action'].includes(command)
          ? state.actions.find((entry) => entry.id === targetId)
          : meeting?.agendas.find((entry) => entry.id === targetId)
            || meeting?.minutes.find((entry) => entry.id === targetId)
            || (meeting && { id: meeting.id, date: meeting.date, time: meeting.time, status: meeting.status, deadline: meeting.deadline });
        const narrative = narrativeCommands.has(command);
        const previousReview = narrative ? before?.narratives?.[body.document] : null;
        const auditReview = (review) => review ? { document: review.document, status: review.status, revision: review.revision } : null;
        const previous = narrative ? auditReview(previousReview) : before ? structuredClone(before) : null;
        const result = move({ parts, body, state, role, at: now(), db });
        audit(state, role, pathname, result.status === 'failed' || body.fail === true ? 'failed' : 'ok', previous, narrative ? auditReview(result) : result);
        write(state);
        db.exec('COMMIT');
        return send(response, 200, result);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (error.status === 403 && roles.has(role)) {
        const state = read();
        audit(state, role, pathname, 'denied');
        write(state);
      }
      if (!error.status) console.error(error);
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const data = process.env.BOARD_DIGEST_DATA || resolve(root, 'data');
  mkdirSync(data, { recursive: true });
  const port = Number(process.env.BOARD_DIGEST_PORT || 8765);
  createApp(resolve(data, 'board.sqlite')).listen(port, '127.0.0.1', () => {
    console.log('The Board Digest  http://127.0.0.1:' + port);
  });
}
