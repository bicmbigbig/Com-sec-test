import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const bundledPython = resolve(process.execPath, '../../..', 'python', 'python.exe');
const python = process.env.BOARD_DIGEST_PYTHON || (existsSync(bundledPython) ? bundledPython : process.platform === 'win32' ? 'python' : 'python3');
import { roles, now, bangkok, HttpError, requireThat, sample, find, audit, stateFor, mutateState } from './model.mjs';

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
  const files = {
    get: (key) => db.prepare('SELECT bytes FROM files WHERE id=?').get(key)?.bytes,
    add: (key, bytes) => db.prepare('INSERT INTO files VALUES (?, ?)').run(key, bytes),
  };
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
        const result = mutateState({ pathname, parts, body, state, role, files, readPresentation });
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
