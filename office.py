"""Read slide text and write a Word draft without opening Office applications."""

import io
import json
from pathlib import PurePosixPath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS = {"p": P, "a": A}
STRICT_NS = {
    "http://purl.oclc.org/ooxml/presentationml/main": P,
    "http://purl.oclc.org/ooxml/drawingml/main": A,
    "http://purl.oclc.org/ooxml/officeDocument/relationships": R,
}


def parse_part(archive, path, budget):
    info = archive.getinfo(path)
    if info.file_size > 2_000_000 or info.file_size > budget[0]:
        raise ValueError("สไลด์มีข้อมูลมากเกินขนาดที่ต้นแบบอ่านได้")
    budget[0] -= info.file_size
    data = archive.read(info).decode("utf-8-sig")
    if re.search(r"<!\s*(DOCTYPE|ENTITY)\b", data, re.IGNORECASE):
        raise ValueError("ไฟล์มีโครงสร้าง XML ที่ระบบเปิดอ่านไม่ได้")
    for strict, common in STRICT_NS.items():
        data = data.replace('"' + strict + '"', '"' + common + '"').replace(
            "'" + strict + "'", "'" + common + "'"
        )
    return ET.fromstring(data)


def extract_slides(data):
    slides = []
    budget = [12_000_000]
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        deck = parse_part(archive, "ppt/presentation.xml", budget)
        relationship_part = parse_part(archive, "ppt/_rels/presentation.xml.rels", budget)
        targets = {
            rel.get("Id"): rel.get("Target")
            for rel in relationship_part.findall(f"{{{PKG}}}Relationship")
            if rel.get("Type", "").endswith("/slide") and rel.get("TargetMode") != "External"
        }
        order = deck.findall("p:sldIdLst/p:sldId", NS)
        if len(order) > 100:
            raise ValueError("ต้นแบบรองรับ PowerPoint สูงสุด 100 สไลด์ต่อไฟล์")
        total_chars = 0
        for number, slide_ref in enumerate(order, 1):
            target = targets.get(slide_ref.get(f"{{{R}}}id"), "")
            if target is None:
                raise ValueError("ไม่พบข้อมูลสไลด์ในไฟล์ PowerPoint")
            if target.startswith("/"):
                path = target.lstrip("/")
            else:
                path = str(PurePosixPath("ppt", target))
            if not path.startswith("ppt/") or ".." in PurePosixPath(path).parts:
                raise ValueError("ตำแหน่งสไลด์ในไฟล์ PowerPoint ไม่ถูกต้อง")
            slide = parse_part(archive, path, budget)
            tree = slide.find("p:cSld/p:spTree", NS)
            paragraphs = []
            title = ""
            if tree is not None:
                for shape in tree.iter():
                    if shape.tag not in (f"{{{P}}}sp", f"{{{P}}}graphicFrame"):
                        continue
                    block = []
                    for paragraph in shape.findall(".//a:p", NS):
                        fragments = [
                            "\n" if node.tag == f"{{{A}}}br" else (node.text or "")
                            for node in paragraph.iter()
                            if node.tag in (f"{{{A}}}t", f"{{{A}}}br")
                        ]
                        text = "".join(fragments).strip()
                        if text:
                            block.append(text)
                            total_chars += len(text)
                            if total_chars > 100_000:
                                raise ValueError("ไฟล์มีข้อความเกินขนาดที่ต้นแบบรองรับ")
                    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
                    if not title and block and placeholder is not None and placeholder.get("type") in ("title", "ctrTitle"):
                        title = block[0]
                    paragraphs.extend(block)
            slides.append({"number": number, "title": title, "paragraphs": paragraphs})
    if not any(slide["paragraphs"] for slide in slides):
        raise ValueError("สไลด์ไม่มีข้อความที่อ่านได้ กรุณาใช้ไฟล์ที่มีข้อความในกล่องข้อความหรือตาราง")
    return slides


def element(parent, tag, **attrs):
    return ET.SubElement(parent, f"{{{W}}}{tag}", {f"{{{W}}}{key}": value for key, value in attrs.items()})


def document_bytes(data):
    ET.register_namespace("w", W)
    doc = ET.Element(f"{{{W}}}document")
    body = element(doc, "body")

    def paragraph(style, text):
        p = element(body, "p")
        element(element(p, "pPr"), "pStyle", val=style)
        for index, line in enumerate(text.split("\n")):
            run = element(p, "r")
            if index:
                element(run, "br")
            t = element(run, "t")
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            t.text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", line)

    paragraph("Title", "ร่างคำบรรยายวาระ")
    paragraph("Subtitle", data["title"])
    paragraph("Normal", f'คณะประชุม {data["board"]}')
    paragraph("Source", f'ไฟล์อ้างอิง {data["filename"]} ฉบับ {data["version"]}')
    for entry in data["paragraphs"]:
        paragraph("Normal", entry["text"])
        source = f'อ้างอิงสไลด์ {entry["slide"]}'
        if entry.get("keywords"):
            source += f'   คำสำคัญ {entry["keywords"]}'
        paragraph("Source", source)
    section = element(body, "sectPr")
    element(section, "pgSz", w="11906", h="16838")
    element(section, "pgMar", top="1180", bottom="1180", left="1350", right="1350", header="720", footer="720", gutter="0")

    styles = ET.Element(f"{{{W}}}styles")
    for style_id, name, size, before, after, color, bold in (
        ("Normal", "Normal", "24", "0", "150", "192833", False),
        ("Title", "Title", "42", "0", "160", "000000", True),
        ("Subtitle", "Subtitle", "30", "0", "140", "192833", True),
        ("Source", "Source note", "20", "0", "220", "465865", False),
    ):
        style = element(styles, "style", type="paragraph", styleId=style_id)
        element(style, "name", val=name)
        props = element(style, "pPr")
        if style_id in ("Title", "Subtitle"):
            element(props, "keepNext")
        element(props, "spacing", before=before, after=after, line="300", lineRule="auto")
        run_props = element(style, "rPr")
        element(run_props, "rFonts", ascii="Tahoma", hAnsi="Tahoma", eastAsia="Tahoma", cs="Tahoma")
        if bold:
            element(run_props, "b")
            element(run_props, "bCs")
        element(run_props, "color", val=color)
        element(run_props, "sz", val=size)
        element(run_props, "szCs", val=size)
        element(run_props, "lang", val="th-TH", bidi="th-TH")

    content_types = f"""<Types xmlns="{CT}">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        for file, kind, target in (
            ("_rels/.rels", "officeDocument", "word/document.xml"),
            ("word/_rels/document.xml.rels", "styles", "styles.xml"),
        ):
            archive.writestr(file, f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{R}/{kind}" Target="{target}"/></Relationships>')
        archive.writestr("word/document.xml", ET.tostring(doc, encoding="utf-8", xml_declaration=True))
        archive.writestr("word/styles.xml", ET.tostring(styles, encoding="utf-8", xml_declaration=True))
    return result.getvalue()


if __name__ == "__main__":
    try:
        if sys.argv[1] == "slides":
            result = json.dumps(extract_slides(sys.stdin.buffer.read()), ensure_ascii=False).encode("utf-8")
        else:
            result = document_bytes(json.load(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")))
        sys.stdout.buffer.write(result)
    except (ValueError, ET.ParseError, zipfile.BadZipFile, KeyError, OSError, RuntimeError) as error:
        message = str(error) if type(error) is ValueError else "เปิดไฟล์ไม่ได้ กรุณาตรวจสอบว่าเป็นไฟล์ PowerPoint .pptx ที่สมบูรณ์"
        sys.stderr.buffer.write(message.encode("utf-8"))
        sys.exit(1)
