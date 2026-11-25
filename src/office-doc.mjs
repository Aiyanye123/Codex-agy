import { posix } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

export const documentSizeLimit = 20 * 1024 * 1024;
export const documentOutputLimit = 14_000;
export const officeExtensions = new Set([".docx", ".xlsx", ".pptx"]);
const expandedSizeLimit = 2 * documentSizeLimit;
const maxEntries = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function invalidZip() {
  throw new Error("ZIP 损坏或结构无效。");
}

function encryptedZip() {
  throw new Error("文档已加密，无法读取。");
}

function zipName(bytes) {
  try { return utf8.decode(bytes); }
  catch { return invalidZip(); }
}

export function openDocumentZip(bytes) {
  if (bytes.length > documentSizeLimit) throw new Error("文档超过 20 MB 限制。");
  // Password-protected OOXML wraps the ZIP in an OLE compound file.
  if (bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") encryptedZip();
  let end = bytes.length - 22;
  const floor = Math.max(0, end - 65535);
  for (; end >= floor; end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < floor) invalidZip();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) || bytes.readUInt16LE(end + 8) !== count ||
      count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) {
    throw new Error("不支持分卷 ZIP 或 ZIP64 文档。");
  }
  if (centralStart + centralSize !== end) invalidZip();
  if (count > maxEntries) throw new Error("ZIP 条目过多。");

  const entries = new Map();
  let cursor = centralStart;
  let expandedSize = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalidZip();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const local = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (bytes.readUInt16LE(cursor + 34)) invalidZip();
    cursor = nameStart + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (cursor > end || !nameLength || local + 30 > centralStart) invalidZip();
    if (flags & 0x2041) encryptedZip();
    if (method !== 0 && method !== 8) throw new Error(`不支持 ZIP 压缩方法 ${method}。`);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) invalidZip();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) invalidZip();
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = zipName(nameBytes);
    const data = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    let dataEnd = data + compressed;
    if (dataEnd > centralStart || !nameBytes.equals(bytes.subarray(local + 30, local + 30 + nameLength)) ||
        entries.has(name) || (method === 0 && compressed !== size)) invalidZip();
    if (/[\\:\x00-\x1f]/u.test(name) || name.startsWith("/") || name.split("/").some(part => part === ".." || part === ".")) invalidZip();
    if (flags & 8) {
      const descriptorMatches = offset => offset + 12 <= centralStart && bytes.readUInt32LE(offset) === checksum &&
        bytes.readUInt32LE(offset + 4) === compressed && bytes.readUInt32LE(offset + 8) === size;
      if (dataEnd + 4 <= centralStart && bytes.readUInt32LE(dataEnd) === 0x08074b50 && descriptorMatches(dataEnd + 4)) dataEnd += 4;
      if (!descriptorMatches(dataEnd)) invalidZip();
      dataEnd += 12;
    }
    expandedSize += size;
    if (size > documentSizeLimit || expandedSize > expandedSizeLimit) throw new Error("ZIP 解压后超过大小限制。");
    entries.set(name, { local, data, dataEnd, compressed, size, method, checksum });
  }
  if (cursor !== end) invalidZip();
  let previousEnd = 0;
  for (const entry of [...entries.values()].sort((first, second) => first.local - second.local)) {
    if (entry.local < previousEnd) invalidZip();
    previousEnd = entry.dataEnd;
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const input = bytes.subarray(entry.data, entry.data + entry.compressed);
    let result = input;
    if (entry.method === 8) {
      try { result = inflateRawSync(input, { maxOutputLength: Math.max(1, entry.size) }); }
      catch { invalidZip(); }
    }
    if (result.length !== entry.size || crc32(result) !== entry.checksum) invalidZip();
    return result;
  }

  return {
    read,
    validate() {
      for (const name of entries.keys()) read(name);
    },
  };
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function invalidXml() {
  throw new Error("Office XML 损坏或包含不支持的声明。");
}

function decodeEntities(value) {
  return value.replace(/&(?:#(?:x[0-9a-fA-F]+|\d+)|[a-zA-Z]+);|&/g, entity => {
    const name = entity.slice(1, -1);
    if (Object.hasOwn(entities, name)) return entities[name];
    if (!name.startsWith("#")) return invalidXml();
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return invalidXml();
    return String.fromCodePoint(code);
  });
}

function parseXml(bytes) {
  let source;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" :
      bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { invalidXml(); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(source)) invalidXml();
  const root = { children: [], text: "" };
  const stack = [root];
  const tokens = /<!--([\s\S]*?)-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w.:-]+)\s*>|<([\w.:-]+)((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)(\/?)>|([^<]+)/gy;
  const attributes = /\s+([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  let offset = 0;
  let nodes = 0;
  while (offset < source.length) {
    const token = tokens.exec(source);
    if (!token) invalidXml();
    offset = tokens.lastIndex;
    const [, comment, cdata, end, start, rawAttributes, selfClosing, content] = token;
    const parent = stack.at(-1);
    if (comment?.includes("--")) invalidXml();
    if (cdata !== undefined || content !== undefined) {
      if (parent === root && (cdata !== undefined || content.trim())) invalidXml();
      if (content?.includes("]]>")) invalidXml();
      if (parent !== root && (cdata !== undefined || content.trim() || parent.name === "t")) {
        parent.text += cdata ?? decodeEntities(content);
      }
    } else if (end) {
      if (parent.qname !== end) invalidXml();
      stack.pop();
    } else if (start) {
      if (++nodes > 250_000 || stack.length > 96) throw new Error("Office XML 超过结构限制。");
      const attrs = Object.create(null);
      attributes.lastIndex = 0;
      let consumed = 0;
      for (let attribute; (attribute = attributes.exec(rawAttributes));) {
        if (Object.hasOwn(attrs, attribute[1])) invalidXml();
        attrs[attribute[1]] = decodeEntities(attribute[2] ?? attribute[3]);
        consumed = attributes.lastIndex;
      }
      if (rawAttributes.slice(consumed).trim()) invalidXml();
      const node = { qname: start, name: start.split(":").at(-1), attrs, children: [], text: "" };
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) invalidXml();
  return root.children[0];
}

function xml(zip, part, name, optional = false) {
  const bytes = zip.read(part);
  if (!bytes && optional) return undefined;
  if (!bytes) throw new Error(`Office 文档缺少部件 ${part}。`);
  const root = parseXml(bytes);
  if (root.name !== name) invalidXml();
  return root;
}

const children = (node, name) => node?.children.filter(child => child.name === name) ?? [];
const child = (node, name) => node?.children.find(item => item.name === name);
const attr = (node, name) => node?.attrs[name] ?? Object.entries(node?.attrs ?? {}).find(([key]) => key.endsWith(`:${name}`))?.[1];
const relId = node => Object.entries(node.attrs).find(([key]) => key.endsWith(":id"))?.[1];

function* descendants(node, name) {
  for (const item of node?.children ?? []) {
    if (item.name === name) yield item;
    else yield* descendants(item, name);
  }
}

function relationships(zip, part, optional = false) {
  const rels = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
  const root = xml(zip, rels, "Relationships", optional);
  return new Map(children(root, "Relationship").map(item => [item.attrs.Id, item.attrs]));
}

function relatedPart(part, relationship, type) {
  if (!relationship?.Type?.endsWith(`/${type}`) || relationship.TargetMode === "External" || !relationship.Target) {
    throw new Error(`Office 文档缺少有效的 ${type} 关系。`);
  }
  const target = decodeURIComponent(relationship.Target);
  const resolved = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.join(posix.dirname(part), target);
  if (/[\\:?#\x00-\x1f]/u.test(target) || resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) invalidXml();
  return resolved;
}

const oneLine = value => value.replace(/\s+/gu, " ").trim();
const escapeCell = value => oneLine(value).replaceAll("|", "\\|");

function paragraphText(node) {
  if (node.name === "t") return node.text;
  if (node.name === "tab" || node.name === "br" || node.name === "cr") return " ";
  return node.children.map(paragraphText).join("");
}

function headingLevel(properties, style = "") {
  const outline = attr(child(properties, "outlineLvl"), "val");
  if (/^[0-8]$/.test(outline)) return Math.min(6, Number(outline) + 1);
  const heading = /^(?:heading\s*([1-9])|title)$/i.exec(style);
  return heading ? Math.min(6, Number(heading[1] ?? 1)) : 0;
}

function* wordBlocks(zip) {
  const document = xml(zip, "word/document.xml", "document");
  const body = child(document, "body");
  if (!body) invalidXml();
  const styles = new Map();
  for (const style of children(xml(zip, "word/styles.xml", "styles", true), "style")) {
    const level = headingLevel(child(style, "pPr"), attr(child(style, "name"), "val"));
    if (level) styles.set(attr(style, "styleId"), level);
  }
  function* blocks(container) {
    for (const node of container.children) {
      if (node.name === "p") {
        const text = oneLine(paragraphText(node));
        if (!text) continue;
        const properties = child(node, "pPr");
        const style = attr(child(properties, "pStyle"), "val");
        const level = headingLevel(properties, style) || styles.get(style);
        yield { text, markdown: level ? `${"#".repeat(level)} ${text}` : text };
      } else if (node.name === "tbl") {
        const rows = [...descendants(node, "tr")].map(row => children(row, "tc").map(cell => {
          return [...descendants(cell, "p")].map(paragraphText).join(" ");
        }));
        const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
        if (!width) continue;
        // Padding a ragged table must not amplify a small XML part into an enormous grid.
        if (width * rows.length > 250_000) throw new Error("Word 表格超过结构限制。");
        const lines = rows.map(row => `| ${Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? "")).join(" | ")} |`);
        lines.splice(1, 0, `|${" --- |".repeat(width)}`);
        yield { text: rows.map(row => row.join(" ")).join("\n"), markdown: lines.join("\n") };
      } else if (["sdt", "sdtContent", "customXml", "ins"].includes(node.name)) {
        yield* blocks(node);
      }
    }
  }
  yield* blocks(body);
}

function richText(node) {
  return (node?.children ?? []).map(item => item.name === "t" ? item.text : item.name === "r" ? child(item, "t")?.text ?? "" : "").join("");
}

function workbook(zip) {
  const part = "xl/workbook.xml";
  const root = xml(zip, part, "workbook");
  const rels = relationships(zip, part);
  const stringsRel = [...rels.values()].find(item => item.Type?.endsWith("/sharedStrings"));
  const stringsPart = stringsRel ? relatedPart(part, stringsRel, "sharedStrings") : "xl/sharedStrings.xml";
  const strings = children(xml(zip, stringsPart, "sst", !stringsRel), "si").map(richText);
  const sheets = children(child(root, "sheets"), "sheet").map(node => {
    const relationship = rels.get(relId(node));
    if (!node.attrs.name || !relationship?.Type) invalidXml();
    const file = relationship.Type.endsWith("/worksheet") ? relatedPart(part, relationship, "worksheet") : null;
    return { name: node.attrs.name, file };
  });
  return { sheets, strings };
}

function columnName(index) {
  let name = "";
  for (; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
  return name;
}

function* sheetRows(zip, sheet, strings, budget) {
  if (!sheet.file) return;
  const worksheet = xml(zip, sheet.file, "worksheet");
  let rowNumber = 0;
  for (const row of children(child(worksheet, "sheetData"), "row")) {
    if (row.attrs.r !== undefined && !/^[1-9]\d{0,6}$/u.test(row.attrs.r)) invalidXml();
    rowNumber = row.attrs.r === undefined ? rowNumber + 1 : Number(row.attrs.r);
    let column = 0;
    const cells = [];
    for (const cell of children(row, "c")) {
      const ref = cell.attrs.r;
      if (ref && !/^[A-Z]{1,3}[1-9]\d{0,6}$/u.test(ref)) invalidXml();
      const label = ref?.match(/^[A-Z]+/u)[0] ?? columnName(column + 1);
      column = [...label].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0);
      const raw = child(cell, "v")?.text ?? "";
      let value = raw;
      if (cell.attrs.t === "s") {
        if (!/^\d+$/u.test(raw) || strings[Number(raw)] === undefined) invalidXml();
        value = strings[Number(raw)];
      } else if (cell.attrs.t === "inlineStr") {
        value = richText(child(cell, "is"));
      }
      budget.remaining -= value.length + label.length;
      if (budget.remaining < 0) throw new Error("Excel 展开的单元格内容超过大小限制。");
      if (value) cells.push({ label, value });
    }
    if (cells.length) yield { row: rowNumber, cells };
  }
}

function* excelBlocks(zip, options) {
  const { sheets, strings } = workbook(zip);
  const selected = options.sheet === undefined ? sheets : sheets.filter(sheet => sheet.name === options.sheet);
  if (!selected.length && options.sheet !== undefined) throw new Error("找不到指定的 Sheet。");
  const budget = { remaining: expandedSizeLimit };
  for (const sheet of selected) {
    const rows = sheetRows(zip, sheet, strings, budget);
    if (options.sheet === undefined && options.query === undefined) {
      const header = rows.next().value;
      const preview = header?.cells.slice(0, 12).map(({ label, value }) => `${label} ${escapeCell(value).slice(0, 80)}`).join(" | ");
      const heading = `### ${oneLine(sheet.name)}`;
      yield { text: sheet.name, markdown: preview ? `${heading}\n第 ${header.row} 行 · ${preview}` : `${heading}\n${sheet.file ? "无内容" : "非数据工作表"}` };
      continue;
    }
    for (const { row, cells } of rows) {
      const label = `${oneLine(sheet.name)} · 第 ${row} 行`;
      const text = cells.map(cell => cell.value).join(" | ");
      const markdown = `${label} · ${cells.map(cell => `${cell.label} ${escapeCell(cell.value)}`).join(" | ")}`;
      yield { text, markdown, sheet: sheet.name, row };
    }
  }
}

function slideText(node, notes = false) {
  if (!notes) return [...descendants(node, "p")].map(paragraphText).map(oneLine).filter(Boolean).join("\n");
  const lines = [];
  for (const shape of descendants(node, "sp")) {
    const placeholder = [...descendants(shape, "ph")][0];
    if (["hdr", "ftr", "dt", "sldNum", "sldImg"].includes(placeholder?.attrs.type)) continue;
    lines.push(slideText(shape));
  }
  return lines.filter(Boolean).join("\n");
}

function* slideBlocks(zip) {
  const part = "ppt/presentation.xml";
  const presentation = xml(zip, part, "presentation");
  const rels = relationships(zip, part);
  let page = 0;
  for (const node of children(child(presentation, "sldIdLst"), "sldId")) {
    page++;
    const slide = relatedPart(part, rels.get(relId(node)), "slide");
    const body = slideText(xml(zip, slide, "sld"));
    const notesRel = [...relationships(zip, slide, true).values()].find(item => item.Type?.endsWith("/notesSlide"));
    const notes = notesRel ? slideText(xml(zip, relatedPart(slide, notesRel, "notesSlide"), "notes"), true) : "";
    const heading = `### 第 ${page} 页`;
    const markdown = [heading, body, notes ? `备注\n${notes}` : ""].filter(Boolean).join("\n\n");
    yield { text: [body, notes].filter(Boolean).join("\n"), markdown, page };
  }
}

function documentBlocks(zip, extension, options) {
  if (extension === ".docx") return wordBlocks(zip);
  if (extension === ".xlsx") return excelBlocks(zip, options);
  return slideBlocks(zip);
}

function matchingBlocks(zip, extension, options) {
  const blocks = documentBlocks(zip, extension, options);
  const query = options.query;
  const fold = value => options.case_sensitive ? value : value.toLowerCase();
  const needle = query === undefined ? undefined : fold(query);
  return (function* () {
    let index = 0;
    for (const block of blocks) {
      index++;
      const hit = needle === undefined ? 0 : fold(block.text).indexOf(needle);
      if (hit >= 0) yield { index, block, hit };
    }
  })();
}

function excerpt(text, start, length) {
  const end = Math.min(start + length, text.length);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function matchExcerpt(text, hit) {
  const start = Math.max(0, hit - 100);
  const preview = excerpt(text, start, 300);
  return oneLine(preview);
}

export function searchOffice(zip, extension, options, limit) {
  const matches = [];
  for (const { index, block, hit } of matchingBlocks(zip, extension, options)) {
    const { page, sheet, row } = block;
    matches.push({ ...(page ? { page } : sheet ? { sheet, row } : { block: index }),
      text: matchExcerpt(block.text, hit),
    });
    if (matches.length === limit) break;
  }
  return matches;
}

export function readOffice(zip, extension, path, options) {
  const { start = 1, limit = extension === ".xlsx" && options.sheet === undefined && options.query === undefined ? Infinity : 20 } = options;
  const unit = extension === ".docx" ? "block" : extension === ".pptx" ? "slide" :
    options.sheet === undefined && options.query === undefined ? "sheet" : "row";
  const result = { path, format: extension.slice(1), unit, start, count: 0, next_start: null, truncated: false, content: "" };
  let position = 0;
  for (const { index, block, hit } of matchingBlocks(zip, extension, options)) {
    position++;
    if (position < start) continue;
    if (result.count === limit) {
      result.next_start = position;
      break;
    }
    const heading = options.query !== undefined && unit === "block" ? `块 ${index}\n` : "";
    const separator = result.count ? "\n\n" : "";
    const rendered = `${heading}${block.markdown}`;
    const remaining = documentOutputLimit - Buffer.byteLength(JSON.stringify(result)) - 64;
    if (rendered.length > remaining || Buffer.byteLength(JSON.stringify(separator + rendered)) > remaining) {
      result.truncated = true;
      if (result.count) {
        result.next_start = position;
        break;
      }
      if (options.query !== undefined) {
        const label = block.page ? `### 第 ${block.page} 页\n` : block.sheet ? `${block.sheet} · 第 ${block.row} 行\n` : heading;
        result.content = label + matchExcerpt(block.text, hit);
        result.count++;
        continue;
      }
      let length = Math.min(rendered.length, remaining);
      let shortened = excerpt(rendered, 0, length);
      while (Buffer.byteLength(JSON.stringify(shortened)) > remaining) {
        length = Math.floor(length / 2);
        shortened = excerpt(rendered, 0, length);
      }
      result.content = shortened;
    } else {
      result.content += separator + rendered;
    }
    result.count++;
  }
  return result;
}
