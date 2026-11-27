import { unzipSync, zipSync, strToU8 } from './fflate.mjs';
import { HttpError, requireThat } from './model.mjs';

const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const strict = {
  'http://purl.oclc.org/ooxml/drawingml/main': drawing,
  'http://purl.oclc.org/ooxml/presentationml/main': presentation,
  'http://purl.oclc.org/ooxml/officeDocument/relationships': relationships,
};
const invalidFile = 'เปิดไฟล์ไม่ได้ กรุณาตรวจสอบว่าเป็นไฟล์ PowerPoint .pptx ที่สมบูรณ์';

function findAll(node, namespace, name) {
  return Array.from(node.getElementsByTagNameNS(namespace, name));
}

function xmlPart(bytes) {
  requireThat(bytes, invalidFile, 422);
  let xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireThat(!/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml), invalidFile, 422);
  for (const [source, destination] of Object.entries(strict)) xml = xml.replaceAll(source, destination);
  const result = new DOMParser().parseFromString(xml, 'application/xml');
  requireThat(!result.getElementsByTagName('parsererror').length, invalidFile, 422);
  return result;
}

function paragraphText(paragraph) {
  return findAll(paragraph, drawing, '*').map((node) => {
    if (node.localName === 'br') return '\n';
    return node.localName === 't' ? node.textContent : '';
  }).join('').trim();
}

export function readPresentation(filename, bytes) {
  requireThat(/\.pptx$/i.test(filename), 'กรุณาเลือกไฟล์ PowerPoint .pptx', 422);
  try {
    let total = 0;
    let count = 0;
    const parts = unzipSync(bytes, { filter: ({ name, originalSize }) => {
      if (!/^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml)$/.test(name)) return false;
      total += originalSize;
      count++;
      requireThat(count <= 102 && originalSize <= 2_000_000 && total <= 12_000_000,
        'ต้นแบบรองรับสูงสุด 100 สไลด์และจำกัดขนาดข้อความในไฟล์', 422);
      return true;
    } });
    const deck = xmlPart(parts['ppt/presentation.xml']);
    const relationList = xmlPart(parts['ppt/_rels/presentation.xml.rels']);
    const slideFiles = new Map(findAll(relationList, packageRels, 'Relationship')
      .filter((entry) => entry.getAttribute('Type')?.endsWith('/slide') && entry.getAttribute('TargetMode') !== 'External')
      .map((entry) => [entry.getAttribute('Id'), entry.getAttribute('Target')]));
    let characters = 0;
    const slides = findAll(deck, presentation, 'sldId').map((entry, index) => {
      const target = slideFiles.get(entry.getAttributeNS(relationships, 'id')) || '';
      const path = target.startsWith('/') ? target.slice(1) : 'ppt/' + target;
      const slide = xmlPart(parts[path]);
      const shapeTree = findAll(slide, presentation, 'spTree')[0];
      const shapes = shapeTree ? findAll(shapeTree, presentation, '*')
        .filter((node) => ['sp', 'graphicFrame'].includes(node.localName)) : [];
      let title = '';
      const paragraphs = shapes.flatMap((shape) => {
        const block = findAll(shape, drawing, 'p').map(paragraphText).filter(Boolean);
        const placeholder = findAll(shape, presentation, 'ph')[0];
        if (!title && block.length && ['title', 'ctrTitle'].includes(placeholder?.getAttribute('type'))) title = block[0];
        return block;
      });
      for (const text of paragraphs) characters += text.length;
      requireThat(characters <= 100_000, 'ไฟล์มีข้อความเกินขนาดที่ต้นแบบรองรับ', 422);
      return { number: index + 1, title, paragraphs };
    });
    requireThat(slides.length <= 100, 'ต้นแบบรองรับสูงสุด 100 สไลด์', 422);
    requireThat(slides.some((slide) => slide.paragraphs.length), 'สไลด์ไม่มีข้อความที่อ่านได้ กรุณาใช้ไฟล์ที่มีข้อความในกล่องข้อความหรือตาราง', 422);
    return slides;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, invalidFile);
  }
}

const escapeXml = (value) => String(value).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
  .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

export function writeWord({ title, board, filename, version, paragraphs }) {
  const para = (style, value) => '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr><w:r><w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r></w:p>';
  const body = [
    para('Title', 'ร่างคำบรรยายวาระ'), para('Subtitle', title),
    para('Normal', 'คณะประชุม ' + board), para('Source', 'ไฟล์อ้างอิง ' + filename + ' ฉบับ ' + version),
    ...paragraphs.flatMap((entry) => [
      para('Normal', entry.text),
      para('Source', 'อ้างอิงสไลด์ ' + entry.slide + (entry.keywords ? '   คำสำคัญ ' + entry.keywords : '')),
    ]),
  ].join('');
  const styles = [
    ['Normal', '24', '192833', '150', false],
    ['Title', '42', '000000', '160', true],
    ['Subtitle', '30', '192833', '140', true],
    ['Source', '20', '465865', '220', false],
  ].map(([name, size, color, spacing, bold]) =>
    '<w:style w:type="paragraph" w:styleId="' + name + '"><w:name w:val="' + name + '"/><w:pPr>' +
    (bold ? '<w:keepNext/>' : '') + '<w:spacing w:after="' + spacing + '" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma" w:cs="Tahoma"/>' +
    (bold ? '<w:b/><w:bCs/>' : '') + '<w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size +
    '"/><w:lang w:val="th-TH"/></w:rPr></w:style>').join('');
  const relation = (type, target) => '<Relationships xmlns="' + packageRels +
    '"><Relationship Id="rId1" Type="' + relationships + '/' + type + '" Target="' + target + '"/></Relationships>';
  const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
  return zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(relation('officeDocument', 'word/document.xml')),
    'word/_rels/document.xml.rels': strToU8(relation('styles', 'styles.xml')),
    'word/styles.xml': strToU8('<w:styles xmlns:w="' + word + '">' + styles + '</w:styles>'),
    'word/document.xml': strToU8('<w:document xmlns:w="' + word + '"><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1180" w:right="1350" w:bottom="1180" w:left="1350" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'),
  });
}
