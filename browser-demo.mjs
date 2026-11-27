import { roles, now, bangkok, HttpError, requireThat, sample, find, audit, stateFor, mutateState } from './model.mjs';
import { readPresentation, writeWord } from './browser-office.mjs';

const sampleFiles = {
  'D-001': 'เอกสารจำลอง: กรอบงบประมาณ ฉบับแรก',
  'D-002': 'เอกสารจำลอง: กรอบงบประมาณ ฉบับปรับปรุง แยกรายการลงทุน',
};
let database;

function connect() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('the-board-digest-demo', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('พื้นที่จัดเก็บถูกใช้งานอยู่ในอีกแท็บ'));
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

function get(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getFile(store, key) {
  if (Object.hasOwn(sampleFiles, key)) return new TextEncoder().encode(sampleFiles[key]);
  return get(store, 'file/' + key);
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

function download(data, type = 'application/octet-stream') {
  return new Response(data, { headers: { 'Content-Type': type } });
}

async function respond(store, state, path, role, body) {
  if (body === undefined && path === '/api/state') {
    return json({ ...stateFor(state, role), today: bangkok.format(new Date()), serverTime: now() });
  }
  if (body === undefined && path.startsWith('/api/file/')) {
    const key = path.split('/').at(-1);
    const agenda = state.meetings.flatMap((meeting) => meeting.agendas).find((entry) => entry.documents.some((doc) => doc.id === key));
    requireThat(agenda, 'ไม่พบไฟล์', 404);
    requireThat(role === 'comsec' || agenda.owner === role, 'ไม่มีสิทธิ์เปิดไฟล์นี้', 403);
    const file = await getFile(store, key);
    requireThat(file, 'ไม่พบไฟล์', 404);
    return download(file);
  }
  if (body === undefined && path.startsWith('/api/narration/')) {
    const [, , , meetingId, agendaId, docId] = path.split('/');
    const meeting = find(state.meetings, meetingId);
    const agenda = find(meeting.agendas, agendaId);
    requireThat(role === 'comsec' || agenda.owner === role, 'ไม่มีสิทธิ์เปิดร่างนี้', 403);
    const document = find(agenda.documents, docId);
    const review = agenda.narratives?.[docId];
    requireThat(review?.status === 'narration_ready', 'กรุณายืนยันประเด็นและสร้างร่างก่อนดาวน์โหลด', 409);
    return download(writeWord({
      title: agenda.title, board: meeting.board, filename: document.name, version: document.number, paragraphs: review.paragraphs,
    }), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }
  requireThat(body !== undefined && path.startsWith('/api/do/'), 'ไม่พบเส้นทาง', 404);
  const parts = path.slice('/api/do/'.length).split('/');
  const source = parts[0] === 'prepare-presentation' && typeof body.document === 'string'
    ? await getFile(store, body.document) : null;
  const files = {
    get: () => source,
    add: (key, bytes) => store.add(bytes, 'file/' + key),
  };
  const result = mutateState({ pathname: path, parts, body, state, role, files, readPresentation });
  store.put(state, 'state');
  return json(result);
}

export async function browserRequest(path, role, body) {
  if (!roles.has(role)) return json({ error: 'กรุณาเลือกบทบาททดลอง' }, 403);
  let transaction;
  try {
    const db = await connect();
    transaction = db.transaction('records', 'readwrite');
    const saved = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    // An aborted transaction can reject before a response has been constructed.
    saved.catch(() => {});
    const store = transaction.objectStore('records');
    const state = await get(store, 'state') || sample();
    let response;
    try {
      response = await respond(store, state, path, role, body);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 403) {
        audit(state, role, path, 'denied');
        store.put(state, 'state');
      }
      response = json({ error: error.message }, error.status);
    }
    await saved;
    return response;
  } catch (error) {
    try { transaction?.abort(); } catch {}
    console.error(error);
    return json({ error: 'เปิดหรือบันทึกข้อมูลในเบราว์เซอร์ไม่ได้ กรุณาตรวจพื้นที่จัดเก็บแล้วลองใหม่' }, 503);
  }
}
