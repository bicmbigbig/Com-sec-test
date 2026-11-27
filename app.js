const $ = (selector) => document.querySelector(selector);
const content = $('#content');
const roleSelect = $('#role');
const roles = { comsec: 'ComSec', finance: 'ฝ่ายการเงิน', operations: 'ฝ่ายปฏิบัติการ' };
const labels = {
  planned: 'กำหนดการ', held: 'จัดประชุมแล้ว', booked: 'จองแล้ว', confirmed: 'ยืนยันแล้ว', cancelled: 'ยกเลิก',
  submitted: 'ส่งแล้วรอตรวจ', revision: 'ขอแก้ไข', accepted: 'ตรวจรับแล้ว',
  draft: 'ร่าง', in_review: 'รอตรวจ', approved: 'รับรองแล้ว', published: 'เผยแพร่แล้ว',
  open: 'เปิด', in_progress: 'กำลังทำ', pending_review: 'รอ ComSec ตรวจ', closed: 'ปิดแล้ว',
  sent: 'ส่งแล้ว', failed: 'ล้มเหลว', ready: 'พร้อมตรวจ', ok: 'สำเร็จ', denied: 'ปฏิเสธสิทธิ์',
  prepared: 'รอยืนยันประเด็น', concepts_confirmed: 'ยืนยันประเด็นแล้ว', narration_ready: 'ร่างพร้อมดาวน์โหลด',
};
const dateFormat = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const timeFormat = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const date = (value) => value ? dateFormat.format(new Date(value + 'T00:00:00+07:00')) : '—';
const time = (value) => value ? timeFormat.format(new Date(value)) : '—';
const h = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const badge = (status, warn = false) => '<span class="badge' + (warn ? ' warning' : '') + '">' + h(labels[status] || status) + '</span>';
const comsec = () => roleSelect.value === 'comsec';
const last = (list) => list.at(-1);
const nonblank = (value) => h(value || '—');
const classButton = (primary) => primary ? ' class="primary"' : '';
let state;
let active = 'meetings';
let currentMeeting = null;
let busy = false;
let dirty = false;
let dataHash = '';
let refreshNumber = 0;
const openSections = new Set();

function tell(message, error = false) {
  const box = $('#message');
  box.textContent = message;
  box.className = 'notice' + (error ? ' error' : '');
  box.hidden = !message;
}

async function api(path, body) {
  const headers = { 'X-Demo-Role': roleSelect.value };
  const options = { headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    Object.assign(options, { method: 'POST', body: JSON.stringify(body) });
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('เชื่อมต่อแอปไม่ได้ กรุณาลองใหม่');
  }
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

async function refresh(force = false) {
  if (!force && busy) return;
  const requestNumber = ++refreshNumber;
  try {
    const latest = await (await api('/api/state')).json();
    if (requestNumber !== refreshNumber) return;
    const { serverTime, ...rows } = latest;
    const deadlinesReached = latest.meetings.filter((meeting) => meeting.deadline <= serverTime).map((meeting) => meeting.id);
    const hash = JSON.stringify([rows, deadlinesReached]);
    state = latest;
    if (force || (!dirty && dataHash !== hash)) {
      render();
      dataHash = hash;
    }
    $('#updated').textContent = 'ตรวจสอบข้อมูลล่าสุด ' + time(serverTime);
  } catch (error) {
    if (requestNumber === refreshNumber) {
      $('#updated').textContent = error.message;
      if (force) throw error;
    }
  } finally {
    content.setAttribute('aria-busy', 'false');
  }
}

function field(label, name, value = '', type = 'text', required = false) {
  const attrs = ' name="' + name + '"' + (required ? ' required' : '');
  const input = type === 'textarea'
    ? '<textarea' + attrs + '>' + h(value) + '</textarea>'
    : '<input' + attrs + ' type="' + type + '" value="' + h(value) + '">';
  return '<label>' + label + input + '</label>';
}

function select(label, name, options) {
  return '<label>' + label + '<select name="' + name + '" required>' +
    options.map(([key, value]) => '<option value="' + h(key) + '">' + h(value) + '</option>').join('') + '</select></label>';
}

const ownerSelect = (label) => select(label, 'owner', Object.entries(roles).filter(([key]) => key !== 'comsec'));
const route = (command, meeting = '_', target = '') => [command, meeting, target].filter(Boolean).join('/');
const meetingFields = (m = {}) => field('วันที่', 'date', m.date || '', 'date', true) + field('เวลาประชุม', 'time', m.time || '10:00', 'time', true) +
  field('เวลาเตือน T−3', 'reminderTime', m.reminderTime || '09:00', 'time', true);

function form(path, fields, label, extras = '') {
  return '<form data-route="' + h(path) + '">' + extras + '<div class="grid">' + fields + '</div><button class="primary">' + label + '</button></form>';
}

function button(path, title, body = {}, primary = false) {
  return '<button type="button" data-route="' + h(path) + '" data-body="' + h(JSON.stringify(body)) + '"' + classButton(primary) + '>' + title + '</button>';
}

function disclose(key, title, inner) {
  return '<details data-key="' + h(key) + '"' + (openSections.has(key) ? ' open' : '') + '><summary>' + title + '</summary>' + inner + '</details>';
}

function heading(title, action = '') {
  return '<div class="heading"><h1>' + title + '</h1>' + action + '</div>';
}

function calendar() {
  const meetings = [...state.meetings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const overdue = meetings.filter((m) => m.status === 'planned' && m.deadline <= state.serverTime)
    .flatMap((m) => m.agendas.filter((a) => a.status === 'confirmed' && last(a.documents)?.status !== 'accepted')).length;
  const counters = [
    ['นัดประชุม', meetings.length], ['เอกสารเกินกำหนด', overdue],
    ['งานติดตามที่ยังเปิด', state.actions.filter((a) => a.status !== 'closed').length],
  ];
  return heading('ปฏิทินประชุม') + '<div class="kpis">' + counters.map(([label, value]) => '<div class="kpi">' + label + '<strong>' + value + '</strong></div>').join('') + '</div>' +
    (comsec() ? '<section class="panel">' + disclose('create', 'สร้างนัดประชุม', form('create-meeting', field('คณะประชุม', 'board', '', 'text', true) + meetingFields(), 'สร้างนัด')) + '</section>' : '') +
    (meetings.length ? meetings.map((m) =>
      '<article class="meeting split"><div><h2>' + h(m.board) + '</h2><p>' + date(m.date) + ' · ' + h(m.time) + ' น. · ' + m.agendas.length + ' วาระ</p><span class="muted">กำหนด T−3 ' + time(m.deadline) + '</span></div><div class="controls">' +
      badge(m.status) + '<button class="primary" data-meeting="' + h(m.id) + '">เปิดนัดประชุม</button></div></article>').join('') : '<p>ยังไม่มีนัดประชุม</p>');
}

function presentationReview(m, a, document, review, owner) {
  const key = 'presentation-' + document.id;
  const path = (command) => route(command, m.id, a.id);
  if (!review) {
    return owner ? '<div class="row">' + h(document.name) + ' · ฉบับ ' + document.number + ' ' +
      button(path('prepare-presentation'), 'อ่านสไลด์เพื่อทำคำบรรยาย', { document: document.id }) + '</div>' : '';
  }
  const hidden = '<input type="hidden" name="document" value="' + h(document.id) + '">' +
    '<input type="hidden" name="revision" value="' + review.revision + '">';
  const confirmed = new Map(review.concepts?.map((concept) => [concept.slide, concept]));
  const slides = review.slides.map((slide) => {
    const saved = confirmed.get(slide.number);
    const source = slide.paragraphs.length
      ? '<ul class="list">' + slide.paragraphs.map((paragraph) => '<li class="preserve">' + h(paragraph) + '</li>').join('') + '</ul>'
      : '<p class="muted">สไลด์นี้ไม่มีข้อความที่ระบบอ่านได้</p>';
    const heading = '<h4>สไลด์ ' + slide.number + (slide.title ? ' · ' + h(slide.title) : '') + '</h4>';
    if (!slide.paragraphs.length) return '<section class="row">' + heading + source + '</section>';
    const guessedConcept = slide.paragraphs.join('\n').slice(0, 1800);
    const checked = saved || review.status === 'prepared';
    const input = owner
      ? '<label class="concept-check"><input type="checkbox" name="include-' + slide.number + '"' + (checked ? ' checked' : '') + '> ใช้สไลด์นี้ในคำบรรยาย</label>' +
        '<div class="grid">' +
        field('ประเด็นหลักของสไลด์ ' + slide.number, 'concept-' + slide.number, saved?.concept ?? guessedConcept, 'textarea').replace('<textarea', '<textarea maxlength="1800"') +
        field('คำสำคัญของสไลด์ ' + slide.number, 'keywords-' + slide.number, saved?.keywords ?? slide.title.slice(0, 220)).replace('<input ', '<input maxlength="220" ') + '</div>'
      : saved ? '<p class="preserve">' + h(saved.concept) + '</p>' : '';
    return '<section class="row">' + heading + disclose(key + '-source-' + slide.number, 'ข้อความต้นฉบับจากสไลด์ ' + slide.number, source) + input + '</section>';
  }).join('');
  const reviewForm = owner
    ? '<p>เทียบกับสไลด์แล้วแก้ประเด็นให้เป็นประโยคที่ต้องการใช้จริง โดยคงตัวเลข หน่วย และเงื่อนไขที่สำคัญไว้</p>' +
      '<form data-route="' + h(path('confirm-concepts')) + '">' + hidden + slides +
      '<button class="primary">' + (review.status === 'prepared' ? 'ยืนยันประเด็นที่เลือก' : 'บันทึกและยืนยันประเด็นใหม่') + '</button></form>'
    : slides;
  const draft = review.paragraphs ? '<div class="row"><h4>ร่างคำบรรยาย</h4>' + review.paragraphs.map((entry) =>
    '<p class="preserve">' + h(entry.text) + '</p><p class="muted">อ้างอิงสไลด์ ' + entry.slide +
    (entry.keywords ? ' · คำสำคัญ ' + h(entry.keywords) : '') + '</p>').join('') +
    '<button class="primary" data-narration="' + h([m.id, a.id, document.id].join('/')) + '">ดาวน์โหลด Word (.docx)</button></div>' : '';
  const generate = owner && review.status === 'concepts_confirmed'
    ? '<div class="row">' + button(path('draft-narration'), 'สร้างร่างคำบรรยาย', { document: document.id, revision: review.revision }, true) + '</div>'
    : '';
  return disclose(key, h(document.name) + ' · ฉบับ ' + document.number + ' · ' + h(labels[review.status]),
    '<div class="presentation-review">' + (review.confirmedAt ? '<p class="muted">ยืนยันล่าสุด ' + time(review.confirmedAt) + '</p>' : '') +
    disclose(key + '-concepts', 'ตรวจคำสำคัญและประเด็นหลัก', reviewForm) + generate + draft + '</div>');
}

function presentations(m, a, owner) {
  const available = a.documents.filter((document) => /\.pptx$/i.test(document.name) && (owner || a.narratives?.[document.id]));
  const canUpload = owner && m.status === 'planned' && ['booked', 'confirmed'].includes(a.status);
  if (!available.length && !canUpload) return '';
  const upload = canUpload ? form(route('upload-presentation', m.id, a.id),
    field('ไฟล์ PowerPoint (.pptx สูงสุด 20 MB)', 'file', '', 'file', true).replace('type="file"', 'type="file" accept=".pptx"'), 'อัปโหลดและอ่านสไลด์') : '';
  return disclose('presentations-' + a.id, 'ทำคำบรรยายจาก PowerPoint', '<div class="presentation-review">' + upload +
    [...available].reverse().map((document) => presentationReview(m, a, document, a.narratives?.[document.id], owner)).join('') + '</div>');
}

function agendaCard(m, a) {
  const planned = m.status === 'planned';
  const current = last(a.documents);
  const overdue = planned && a.status === 'confirmed' && m.deadline <= state.serverTime && current?.status !== 'accepted';
  const path = (command) => route(command, m.id, a.id);
  const docs = a.documents.map((d) => '<li><button data-file="' + h(d.id) + '" data-name="' + h(d.name) + '">ดาวน์โหลด ' + h(d.name) + '</button> ฉบับ ' + d.number + ' ' +
    badge(d.status, d.status === 'revision') + (a.usedDocument === d.id ? ' ' + badge('ฉบับใช้ประชุม') : '') +
    (d.reason ? ' <span>' + h(d.reason) + '</span>' : '') +
    (comsec() && planned && a.status === 'confirmed' && d.status === 'accepted' && a.usedDocument !== d.id
      ? ' ' + button(path('use-document'), 'เลือกใช้ประชุม', { document: d.id }) : '') + '</li>').join('');
  const review = current?.status === 'submitted' && comsec() && planned
    ? '<div class="controls">' + button(path('review'), 'ตรวจรับฉบับล่าสุด', { document: current.id, status: 'accepted' }) + '</div>' +
      disclose('review' + a.id, 'ขอแก้ไขฉบับล่าสุด', form(path('review'), field('เหตุผล', 'reason', '', 'text', true), 'ส่งคำขอแก้ไข',
        '<input type="hidden" name="document" value="' + h(current.id) + '"><input type="hidden" name="status" value="revision">'))
    : '';
  const decision = comsec() && planned && ['booked', 'confirmed'].includes(a.status)
    ? disclose('confirm' + a.id, a.status === 'booked' ? 'ยืนยันและจัดลำดับ' : 'แก้ลำดับหรือยกเลิก',
        form(path('confirm'), field('ลำดับวาระ', 'order', a.order || Math.max(0, ...m.agendas.map((entry) => entry.order || 0)) + 1, 'number', true), 'บันทึกลำดับ') +
        '<div class="row">' + button(path('cancel'), 'ยกเลิกวาระ') + '</div>')
    : '';
  return '<article class="row"><div class="split"><h3>' + (a.order ? a.order + '. ' : '') + h(a.title) + '</h3><div>' +
    badge(a.status) + (overdue ? ' ' + badge('เอกสารเกินกำหนด', true) : '') + '</div></div><p>' + h(roles[a.owner]) + ' · ' + h(a.objective) + '</p>' +
    (a.proposal ? '<p class="preserve">' + h(a.proposal) + '</p>' : '') +
    (a.authority ? '<p class="muted">อ้างอิงอำนาจอนุมัติ ' + h(a.authority) + '</p>' : '') +
    (docs ? '<ul class="list">' + docs + '</ul>' : '<p class="muted">ยังไม่ส่งเอกสาร</p>') + decision + review +
    (planned && a.owner === roleSelect.value && ['booked', 'confirmed'].includes(a.status)
      ? disclose('upload' + a.id, 'ส่งเอกสารฉบับใหม่', form(path('upload'), field('เลือกไฟล์ (สูงสุด 2 MB)', 'file', '', 'file', true), 'ส่งเอกสาร')) : '') +
    presentations(m, a, a.owner === roleSelect.value) + '</article>';
}

const itemFields = { summary: 'สาระเสนอ', opinions: 'ความเห็น', resolution: 'มติ', evidence: 'หลักฐานอ้างอิง', pending: 'ประเด็นรอยืนยัน' };

function minutes(m) {
  if (!comsec() || m.status !== 'held') return '';
  const versions = [...m.minutes].reverse();
  const current = versions[0];
  const generation = m.generation;
  const agenda = (key) => m.agendas.find((entry) => entry.id === key)?.title || key;
  const view = (item) => Object.entries(itemFields).map(([key, title]) =>
    '<p class="preserve"><strong>' + title + '</strong> ' + nonblank(item[key]) + '</p>').join('');
  const versionsHtml = versions.map((v) => {
    let controls = '';
    if (v.status === 'draft') controls = button(route('submit', m.id, v.id), 'ส่งให้ตรวจ', {}, true);
    if (v.status === 'in_review') controls = button(route('approve', m.id, v.id), 'รับรองรายงาน', {}, true);
    if (v.status === 'approved') controls = button(route('publish', m.id, v.id), 'เผยแพร่รายงาน', {}, true);
    if (['approved', 'published'].includes(v.status) && !['draft', 'in_review'].includes(current?.status)) {
      controls += button(route('revise', m.id, v.id), 'สร้างฉบับแก้ไข');
    }
    const items = v.items.map((item) => disclose('minute' + v.id + item.agenda, h(agenda(item.agenda)),
      v.status === 'draft' ? form(route('save-minutes', m.id, v.id), Object.entries(itemFields).map(([key, title]) => field(title, key, item[key], 'textarea')).join(''), 'บันทึกร่างวาระ',
        '<input type="hidden" name="agenda" value="' + h(item.agenda) + '">') : view(item))).join('');
    const action = ['approved', 'published'].includes(v.status) ? disclose('action' + v.id, 'สร้างงานติดตามจากรายงานฉบับนี้',
      form(route('create-action', m.id, v.id), select('วาระ', 'agenda', v.items.map((item) => [item.agenda, agenda(item.agenda)])) + ownerSelect('เจ้าของงาน') +
        field('งานที่ต้องทำ', 'task', '', 'text', true) + field('วันครบกำหนด', 'due', '', 'date', true), 'สร้างงานติดตาม')) : '';
    return '<article class="row"><div class="split"><h3>ฉบับ ' + v.number + ' ' + badge(v.status) + '</h3><div class="controls">' + controls + '</div></div>' +
      (v.approvedBy ? '<p class="muted">ผู้รับรอง ' + h(roles[v.approvedBy]) + ' · ' + time(v.approvedAt) + '</p>' : '') +
      (v.publishedAt ? '<p class="muted">เผยแพร่ ' + time(v.publishedAt) + '</p>' : '') + items + action + '</article>';
  }).join('');
  const generationHtml = generation ? '<div class="row">' + badge(generation.status, generation.status === 'failed') + ' ' + time(generation.at) +
    (generation.reason ? '<p>' + h(generation.reason) + '</p>' : disclose('generated', 'ดูผลร่างจาก transcript', generation.items.map((item) =>
      '<section class="row"><h3>' + h(agenda(item.agenda)) + '</h3>' + view(item) + '</section>').join(''))) + '</div>' : '';
  return '<section class="panel"><h2>รายงานการประชุม</h2><div class="controls">' +
    (!['draft', 'in_review'].includes(current?.status) ? button(route('draft', m.id), 'สร้างร่างด้วยตนเอง') : '') +
    (current?.status !== 'in_review' ? button(route('generate', m.id), generation?.status === 'failed' ? 'ลองร่างใหม่' : 'จำลองร่างจาก transcript', {}, true) +
      button(route('generate', m.id), 'ทดสอบร่างล้มเหลว', { fail: true }) : '') +
    '</div>' + generationHtml + versionsHtml + '</section>';
}

function meetingPage(m) {
  const planned = m.status === 'planned';
  const ordered = [...m.agendas].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  const path = (command) => route(command, m.id);
  const transcriptForm = m.agendas.some((entry) => ['confirmed', 'held'].includes(entry.status))
    ? '<form data-route="' + h(path('transcript')) + '" data-target="agenda"><div class="grid">' +
      select('วาระ', 'agenda', ordered.filter((entry) => ['confirmed', 'held'].includes(entry.status)).map((a) => [a.id, a.title])) +
      field('รหัส transcript', 'source', 'TR-001', 'text', true) + field('ช่วงเวลา', 'timestamp', '', 'text', true) +
      field('ข้อความ', 'text', '', 'textarea', true) + '</div><button class="primary">เพิ่มข้อความ</button></form>'
    : '';
  const internal = comsec() ? '<section class="panel"><h2>การจัดประชุม</h2>' +
    (planned ? disclose('reschedule', 'เลื่อนวันประชุมหรือเปลี่ยนเวลาเตือน', form(path('reschedule'), meetingFields(m), 'บันทึกกำหนดใหม่')) +
      disclose('hold', 'บันทึกการจัดประชุม', form(path('hold'), field('ผู้เข้าร่วม', 'attendees', '', 'textarea'), 'ยืนยันว่าจัดประชุมแล้ว')) :
      '<p class="preserve">ผู้เข้าร่วม ' + nonblank(m.attendees) + '</p>') +
    (m.history.length ? disclose('history', 'ประวัติกำหนดเดิม', '<ul class="list">' + m.history.map((item) => '<li>' + date(item.date) + ' · ' + h(item.time) + ' น. · T−3 ' + time(item.deadline) + '</li>').join('') + '</ul>') : '') +
    disclose('transcript', 'หลักฐาน transcript', (m.transcript.length ? '<ul class="list">' + m.transcript.map((item) =>
      '<li><strong>' + h(item.source) + ' ' + h(item.timestamp) + '</strong> ' + h(item.text) + '</li>').join('') + '</ul>' : '<p>ยังไม่มี transcript</p>') + transcriptForm) + '</section>' : '';
  return heading(h(m.board), '<button data-back>กลับปฏิทิน</button>') +
    '<section class="panel"><div class="split"><h2>' + date(m.date) + ' · ' + h(m.time) + ' น.</h2>' + badge(m.status) + '</div><p>กำหนด T−3 ' + time(m.deadline) + '</p></section>' +
    '<section class="panel"><h2>วาระและเอกสาร</h2>' +
      (planned ? disclose('book', 'จองวาระ', form(path('book'), field('หัวข้อ', 'title', '', 'text', true) + field('วัตถุประสงค์', 'objective', '', 'text', true) +
        field('ข้อเสนอ', 'proposal', '', 'textarea') + field('อ้างอิงอำนาจอนุมัติ', 'authority') + (comsec() ? ownerSelect('เจ้าของวาระ') : ''), 'ส่งวาระ')) : '') +
      (ordered.map((a) => agendaCard(m, a)).join('') || '<p>ยังไม่มีวาระ</p>') + '</section>' + internal + minutes(m);
}

function actions() {
  const cards = state.actions.map((a) => {
    const overdue = a.status !== 'closed' && a.due < state.today;
    const owner = roleSelect.value === a.owner;
    return '<article class="panel"><div class="split"><h2>' + h(a.task) + '</h2><div>' + badge(a.status) + (overdue ? ' ' + badge('เกินกำหนด', true) : '') + '</div></div>' +
      '<p>' + h(roles[a.owner]) + ' · ครบกำหนด ' + date(a.due) + '</p><p class="muted">อัปเดต ' + time(a.updated) +
      (a.closedBy ? ' · ปิดโดย ' + h(roles[a.closedBy]) : '') + '</p>' +
      (a.proof ? '<p class="preserve">หลักฐาน ' + h(a.proof) + '</p>' : '') +
      (owner && a.status === 'open' ? button(route('update-action', '_', a.id), 'เริ่มดำเนินการ', { status: 'in_progress' }) : '') +
      (owner && ['open', 'in_progress'].includes(a.status) ? disclose('proof' + a.id, 'ส่งให้ ComSec ตรวจ', form(route('update-action', '_', a.id), field('หลักฐานปิดงาน', 'proof', '', 'textarea', true), 'ส่งให้ตรวจ',
        '<input type="hidden" name="status" value="pending_review">')) : '') +
      (comsec() && a.status === 'pending_review' ? button(route('close-action', '_', a.id), 'ตรวจและปิดงาน', {}, true) : '') + '</article>';
  });
  return heading('งานติดตาม') + (cards.join('') || '<section class="panel"><p>ยังไม่มีงานติดตาม</p></section>');
}

function reminders() {
  const results = state.reminders.map((r) => {
    const m = state.meetings.find((entry) => entry.id === r.meeting);
    const a = m?.agendas.find((entry) => entry.id === r.agenda);
    return '<article class="panel"><div class="split"><h2>' + h(a?.title || r.agenda) + '</h2>' + badge(r.status, r.status === 'failed') + '</div>' +
      '<p>กำหนด ' + time(r.due) + '</p><ul class="list">' + r.attempts.map((attempt) => '<li>' + time(attempt.at) + ' · ' + h(labels[attempt.status]) + '</li>').join('') + '</ul></article>';
  });
  const fields = field('เวลาจำลอง (กรุงเทพฯ)', 'at', '2027-02-07T09:00', 'datetime-local') +
    '<label>จำลองการส่งล้มเหลว<input type="checkbox" name="fail"></label>';
  return heading('การแจ้งเตือน T−3') + '<section class="panel"><h2>จำลองการแจ้งเตือนในโปรแกรม</h2>' + form('remind', fields, 'รันการแจ้งเตือน') + '</section>' +
    (results.join('') || '<section class="panel"><p>ยังไม่มีประวัติแจ้งเตือน</p></section>');
}

function auditPage() {
  return heading('ประวัติการทำงาน') + (state.audit.map((entry, index) => '<article class="panel"><div class="split"><strong>' + h(roles[entry.role]) + ' · ' + time(entry.at) +
    '</strong>' + badge(entry.outcome, entry.outcome !== 'ok') + '</div><p class="audit-route">' + h(entry.route) + '</p>' +
    (entry.before || entry.after ? disclose('audit' + entry.at + index, 'ดูค่าที่บันทึก', '<pre class="preserve">' +
      h(JSON.stringify({ ก่อน: entry.before, หลัง: entry.after }, null, 2)) + '</pre>') : '') + '</article>').join('') || '<p>ยังไม่มีประวัติ</p>');
}

function render() {
  for (const item of document.querySelectorAll('#nav button')) {
    item.hidden = item.hasAttribute('data-internal') && !comsec();
    if (item.dataset.tab === active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (active === 'meetings') {
    const m = state.meetings.find((entry) => entry.id === currentMeeting);
    content.innerHTML = m ? meetingPage(m) : calendar();
  }
  if (active === 'actions') content.innerHTML = actions();
  if (active === 'reminders') content.innerHTML = reminders();
  if (active === 'audit') content.innerHTML = auditPage();
}

async function fileData(file, maxMB = 2) {
  if (!file || !file.size || file.size > maxMB * 1024 * 1024) throw new Error('กรุณาเลือกไฟล์ขนาดไม่เกิน ' + maxMB + ' MB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

async function mutate(control, path, getBody) {
  if (busy) return;
  busy = true;
  control.disabled = true;
  roleSelect.disabled = true;
  tell('');
  let saved = false;
  try {
    const body = await getBody();
    const result = await (await api('/api/do/' + path, body)).json();
    saved = true;
    dirty = false;
    if (/^(upload-presentation|prepare-presentation|confirm-concepts|draft-narration)\//.test(path)) {
      openSections.add('presentation-' + result.document);
      if (result.status === 'prepared') openSections.add('presentation-' + result.document + '-concepts');
      else openSections.delete('presentation-' + result.document + '-concepts');
    }
    await refresh(true);
    const isFailure = result.status === 'failed' || (body.fail === true && result.attempted > 0);
    const status = ('attempted' in result) ? 'ประมวลผล ' + result.attempted + ' รายการ'
      : { prepared: 'อ่านสไลด์แล้ว ตรวจและยืนยันประเด็นได้เลย', concepts_confirmed: 'ยืนยันประเด็นแล้ว พร้อมสร้างร่างคำบรรยาย', narration_ready: 'ร่างคำบรรยายพร้อมดาวน์โหลด' }[result.status] || 'บันทึกแล้ว';
    tell(isFailure ? (result.reason || 'จำลองส่งล้มเหลว เปิดการแจ้งเตือนเพื่อรันใหม่ได้') : status, isFailure);
  } catch (error) {
    tell(saved ? 'บันทึกแล้ว แต่โหลดข้อมูลล่าสุดไม่ได้' : error.message, true);
  } finally {
    busy = false;
    roleSelect.disabled = false;
    control.disabled = false;
  }
}

content.addEventListener('input', () => { dirty = true; });
content.addEventListener('toggle', (event) => {
  const element = event.target;
  if (!element.isConnected || !element.dataset.key) return;
  if (element.open) openSections.add(element.dataset.key);
  else openSections.delete(element.dataset.key);
}, true);
content.addEventListener('submit', (event) => {
  event.preventDefault();
  const formElement = event.target;
  const data = Object.fromEntries(new FormData(formElement));
  const path = formElement.dataset.route + (formElement.dataset.target ? '/' + data[formElement.dataset.target] : '');
  mutate(event.submitter || formElement.querySelector('button'), path, async () => {
    if ('file' in data) {
      const presentation = path.startsWith('upload-presentation/');
      if (presentation && !/\.pptx$/i.test(data.file.name)) throw new Error('กรุณาเลือกไฟล์ PowerPoint .pptx');
      const upload = { name: data.file.name, content: await fileData(data.file, presentation ? 20 : 2) };
      return upload;
    }
    if (path.startsWith('confirm-concepts/')) {
      const concepts = Object.keys(data).filter((key) => /^include-\d+$/.test(key)).map((key) => {
        const slide = Number(key.slice('include-'.length));
        return { slide, concept: data['concept-' + slide], keywords: data['keywords-' + slide] };
      });
      return { document: data.document, revision: Number(data.revision), concepts };
    }
    if (path === 'remind') {
      data.fail = data.fail === 'on';
      if (data.at) data.at += ':00+07:00';
    }
    return data;
  });
});
content.addEventListener('click', async (event) => {
  const control = event.target.closest('button');
  if (!control || busy) return;
  const { meeting, file, name, narration, route: path, body } = control.dataset;
  if (path) mutate(control, path, () => JSON.parse(body));
  if (file || narration) {
    try {
      const response = await api(file ? '/api/file/' + file : '/api/narration/' + narration);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name || 'agenda-narration.docx';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      tell(error.message, true);
    }
  }
  if (meeting || control.hasAttribute('data-back')) {
    currentMeeting = meeting || null;
    resetView();
  }
});

function resetView() {
  dirty = false;
  openSections.clear();
  tell('');
  render();
  window.scrollTo(0, 0);
}

$('#nav').addEventListener('click', (event) => {
  if (!state || busy || !event.target.dataset.tab) return;
  active = event.target.dataset.tab;
  currentMeeting = null;
  resetView();
});
roleSelect.addEventListener('change', () => {
  active = 'meetings';
  dirty = false;
  state = null;
  openSections.clear();
  tell('');
  content.textContent = 'กำลังโหลดข้อมูล…';
  refresh(true).catch((error) => tell(error.message, true));
});
refresh(true).catch((error) => tell(error.message, true));
setInterval(() => refresh(), 30_000);
