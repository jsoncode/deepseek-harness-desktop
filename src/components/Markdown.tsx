/**
 * 轻量 Markdown 渲染器（零依赖）。
 *
 * 为什么不引入 react-markdown / marked：
 * - 插件详情弹框只需要 README 的常规排版（标题/段落/列表/代码/表格/引用/链接），
 *   引入完整解析器会显著增加包体，且其默认 HTML 透传需要额外配置 sanitize；
 * - 本实现直接产出 React 元素树（不经过 dangerouslySetInnerHTML），
 *   所有文本节点由 React 转义，从根上杜绝 README 里的 HTML/脚本注入；
 *   链接与图片地址只允许 http/https，其他协议（javascript:、data: 等）降级为纯文本。
 *
 * 支持范围：ATX 标题、粗体/斜体/删除线/行内代码、围栏与缩进代码块、
 * 有序/无序列表（含嵌套）、任务列表、引用块、水平线、GFM 表格、图片与图链，
 * 以及 README 常见的裸 HTML 降级处理（见下方 stripSafeHtml）。
 *
 * 外链行为：点击一律经 `api.openInBrowser` 交回系统浏览器，
 * 避免在应用 WebView 内跳转导致用户丢失当前界面。
 */

import type { ReactNode } from "react";
import { api, tauri } from "../lib/tauri";

/** 外链统一交回系统浏览器打开：WebView 内直接跳走会让用户丢失应用上下文 */
function openExternal(e: React.MouseEvent, href: string) {
  e.preventDefault();
  if (tauri) {
    void api.openInBrowser(href).catch(() => {
      window.open(href, "_blank", "noopener");
    });
  } else {
    window.open(href, "_blank", "noopener");
  }
}

/**
 * README 里常混入裸 HTML（`<div align="center">` 居中头图、`<br>`、`<hr>`、
 * `<p>`、`<details>` 折叠块、`<img>`/`<a>` 徽标等）。直接转义会让用户看到
 * 一堆可见标签，很难看；但放行任意 HTML 又会引入注入风险。
 *
 * 处理分三层：
 * 1. `<!-- 注释 -->` 直接删除；
 * 2. 纯排版标签（div/br/p/sup/details…）**只删标签本身、保留内部文本**，
 *    让内部内容继续走 Markdown 解析；
 * 3. `<img>` / `<a>` 是 href/src 的载体，不能简单删也不能原样放行——
 *    提取属性后重建为受控的图片/链接节点，URL 仍走 http(s) 白名单校验。
 *
 * 白名单之外的一切标签（script/iframe/style/object…）保持原样，
 * 最终由 React 转义为普通文字，因此永远不会被当作元素执行。
 * 用正则而非 DOM 解析：这里只做标签级替换、不构建树，
 * 不存在 HTML 解析器容错带来的错配与 mXSS 风险。
 */
const STRUCT_TAGS = [
  "div", "span", "p", "br", "hr", "b", "i", "u", "s", "em", "strong", "sup", "sub",
  "small", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "details", "summary", "kbd", "mark", "center",
  "blockquote", "dl", "dt", "dd", "del", "ins", "figure", "figcaption", "caption",
];

const RE_STRUCT_HTML = new RegExp(`</?(?:${STRUCT_TAGS.join("|")})(?:\\s[^>]*)?/?>`, "gi");

/** 取标签属性值（大小写不敏感；支持单/双引号与无引号） */
function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * 把 HTML 片段降级为 Markdown 等价写法，从而复用同一套行内解析与协议白名单：
 * - `<img src alt>` → `![alt](src)`
 * - `<a href>文字</a>` → `[文字](href)`
 * URL 非 http(s) 时输出纯文本，避免生成危险链接。
 */
function htmlToMarkdown(src: string): string {
  let out = src;
  // <img ...>（自闭合或未闭合）
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const s = attrOf(tag, "src");
    if (!s || !/^https?:\/\//i.test(s)) return "";
    const alt = attrOf(tag, "alt") ?? "";
    return `![${alt}](${s})`;
  });
  // <a ...>…</a>：仅在成对出现时转换；href 非法则只保留可见文字
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_whole, attrs, inner) => {
    const h = attrOf(`<a${attrs}>`, "href");
    const text = inner.replace(/\s+/g, " ").trim();
    if (h && /^https?:\/\//i.test(h)) return `[${text || h}](${h})`;
    return text || "";
  });
  // <picture><source …><img …></picture> 与裸 <source>：取 srcset 首项当作图片
  // （暗色/亮色两版徽标只保留第一版，避免同一位置出现两张图）
  out = out.replace(/<source\b[^>]*>/gi, (tag) => {
    const s = attrOf(tag, "srcset") ?? attrOf(tag, "src");
    const url = s?.split(",")[0]?.trim().split(/\s+/)[0];
    return url && /^https?:\/\//i.test(url) ? `![${attrOf(tag, "alt") ?? ""}](${url})` : "";
  });
  return out;
}

/** 当前块级/行内解析前的预处理：去注释、降级裸 HTML、删排版标签 */
function stripSafeHtml(src: string): string {
  return htmlToMarkdown(
    src
      .replace(/<!--[\s\S]*?-->/g, "")
      // <br> 相当于硬换行：转空行让上下内容分成两个块，避免文字被粘连
      .replace(/<br\s*\/?>/gi, "\n\n")
      .replace(/<\/?(?:div|p|center|details|summary|h[1-6]|li|tr|blockquote|figure|figcaption|dl|dt|dd)[^>]*>/gi, "\n")
      .replace(RE_STRUCT_HTML, ""),
  );
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

interface InlineText {
  kind: "text";
  text: string;
}
interface InlineLink {
  kind: "link";
  text: string;
  href: string;
}
interface InlineImage {
  kind: "image";
  alt: string;
  src: string;
  /** 图片被链接包裹时（README 徽标常见写法）记录外链地址 */
  href: string | null;
}
type Inline = InlineText | InlineLink | InlineImage;

/**
 * 拆出图片 `![alt](src)`、`[文字](地址)` 与裸 URL，其余原样保留。
 * 只接受 http/https 地址；`javascript:` 之类直接当普通文字渲染。
 * 图片须先于链接匹配，否则 `[![alt](src)](href)` 会被链接规则截断。
 */
function splitLinks(src: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /\[!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)\]\(\s*([^)\s]+)[^)]*\)|!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)|\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    const raw = m[0];
    if (m[1] !== undefined || m[4] !== undefined) {
      // 图片（可能被链接包裹）
      const alt = m[1] ?? m[4] ?? "";
      const imgSrc = m[2] ?? m[5] ?? "";
      const wrap = m[3] ?? null;
      if (/^https?:\/\//i.test(imgSrc)) {
        out.push({ kind: "image", alt, src: imgSrc, href: wrap && /^https?:\/\//i.test(wrap) ? wrap : null });
      } else {
        out.push({ kind: "text", text: alt || raw });
      }
    } else {
      const label = m[6] ?? "";
      const href = m[7] ?? m[8] ?? "";
      if (/^https?:\/\//i.test(href)) {
        out.push({ kind: "link", text: label || href, href });
      } else {
        // 非 http(s) 协议：不生成链接，原样显示避免钓鱼
        out.push({ kind: "text", text: raw });
      }
    }
    last = m.index + raw.length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

/** 行内代码：反引号成对匹配，奇数个反引号视为普通字符 */
function splitCode(src: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const segs = src.split(/(`+)/);
  let buf = "";
  let fence: string | null = null;
  for (const seg of segs) {
    if (/^`+$/.test(seg)) {
      if (fence === null) {
        if (buf) parts.push({ code: false, text: buf });
        buf = "";
        fence = seg;
      } else if (seg === fence) {
        parts.push({ code: true, text: buf });
        buf = "";
        fence = null;
      } else {
        buf += seg;
      }
    } else {
      buf += seg;
    }
  }
  // 未闭合的反引号还原为普通文本
  if (fence !== null) buf = fence + buf;
  if (buf) parts.push({ code: false, text: buf });
  return parts;
}

/**
 * 行内渲染：先切代码段（代码内不做任何标记解析），
 * 再依次处理粗体 / 斜体 / 删除线 / 链接。
 */
function renderInline(src: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let n = 0;
  for (const part of splitCode(src)) {
    if (part.code) {
      nodes.push(
        <code className="md-code" key={`${keyPrefix}-c${n++}`}>
          {part.text}
        </code>,
      );
      continue;
    }
    for (const piece of splitLinks(part.text)) {
      if (piece.kind === "image") {
        // README 徽标常见写法：图片本身即链接。图片加载失败时回退为可点击的 alt 文本，
        // 避免外网资源不可达时留下一片空白
        const img = (
          <img
            className="md-img"
            key={`${keyPrefix}-i${n++}`}
            src={piece.src}
            alt={piece.alt}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        );
        nodes.push(
          piece.href ? (
            <a className="md-link" key={`${keyPrefix}-iw${n++}`} href={piece.href} onClick={(e) => openExternal(e, piece.href!)}>
              {img}
            </a>
          ) : (
            img
          ),
        );
      } else if (piece.kind === "link") {
        nodes.push(
          <a
            className="md-link"
            key={`${keyPrefix}-a${n++}`}
            href={piece.href}
            onClick={(e) => openExternal(e, piece.href)}
          >
            {piece.text}
          </a>,
        );
      } else {
        nodes.push(...renderEmphasis(piece.text, `${keyPrefix}-t${n++}`));
      }
    }
  }
  return nodes;
}

/** 粗体 / 斜体 / 删除线：逐层用正则切分，未闭合时保留原样 */
function renderEmphasis(src: string, keyPrefix: string): ReactNode[] {
  const rules: Array<{ re: RegExp; wrap: (c: ReactNode, k: string) => ReactNode }> = [
    {
      re: /\*\*([^*]+)\*\*|__([^_]+)__/,
      wrap: (c, k) => (
        <strong key={k}>{c}</strong>
      ),
    },
    {
      re: /(?:\*([^*]+)\*)|(?:_([^_]+)_)/,
      wrap: (c, k) => <em key={k}>{c}</em>,
    },
    {
      re: /~~([^~]+)~~/,
      wrap: (c, k) => (
        <del key={k}>{c}</del>
      ),
    },
  ];

  let current: ReactNode[] = [src];
  let n = 0;
  for (const rule of rules) {
    const next: ReactNode[] = [];
    for (const node of current) {
      if (typeof node !== "string") {
        next.push(node);
        continue;
      }
      let rest = node;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(rest)) !== null) {
        const inner = m[1] ?? m[2] ?? "";
        if (m.index > 0) next.push(rest.slice(0, m.index));
        next.push(rule.wrap(inner, `${keyPrefix}-e${n++}`));
        rest = rest.slice(m.index + m[0].length);
      }
      if (rest) next.push(rest);
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "quote"; lines: string[] }
  | { type: "table"; head: string[]; rows: string[][]; aligns: Array<"l" | "c" | "r"> }
  | { type: "hr" };

interface ListItem {
  text: string;
  checked: boolean | null;
  children: Block[];
}

const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
const RE_OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TASK = /^\[([ xX])\]\s+(.*)$/;

/** 表格分隔行：|---|---:|:---:| */
function isTableDelim(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

/** 按未转义的竖线切单元格 */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 水平线
    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // ATX 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // 围栏代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const close = new RegExp(`^\\s{0,3}${marker === "`" ? "`" : "~"}{3,}\\s*$`);
        if (close.test(cur)) {
          i++;
          break;
        }
        buf.push(cur);
        i++;
      }
      blocks.push({ type: "code", lang, code: buf.join("\n") });
      continue;
    }

    // 引用块：连续 > 行合并（内部仍按块解析，支持引用里放列表/代码）
    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i]);
        if (q) {
          buf.push(q[1]);
          i++;
          continue;
        }
        // 引用块内的空行：仅当下一行仍是引用时保留，否则结束
        if (!lines[i].trim() && RE_QUOTE.test(lines[i + 1] ?? "")) {
          buf.push("");
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "quote", lines: buf });
      continue;
    }

    // 缩进代码块（4 空格 / 1 Tab）
    if (/^(?: {4}|\t)/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim() && !/^(?: {4}|\t)/.test(lines[i + 1] ?? "")) break;
        buf.push(lines[i].replace(/^(?: {4}|\t)/, ""));
        i++;
      }
      blocks.push({ type: "code", lang: "", code: buf.join("\n") });
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      const aligns = delim.map((d) => {
        const l = d.startsWith(":");
        const r = d.endsWith(":");
        return l && r ? "c" : r ? "r" : "l";
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", head, rows, aligns });
      continue;
    }

    // 列表（有序 / 无序，含嵌套与任务项）
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line);
      const { items, next } = parseList(lines, i, ordered);
      blocks.push({ type: "list", ordered, items });
      i = next;
      continue;
    }

    // 段落：吸收后续非空行（惰性续行）
    const buf: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim()) {
      const cur = lines[i];
      if (
        RE_HEADING.test(cur) ||
        RE_HR.test(cur) ||
        RE_FENCE.test(cur) ||
        RE_QUOTE.test(cur) ||
        RE_UL.test(cur) ||
        RE_OL.test(cur) ||
        /^(?: {4}|\t)/.test(cur) ||
        (cur.includes("|") && i + 1 < lines.length && isTableDelim(lines[i + 1]))
      ) {
        break;
      }
      buf.push(cur.trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: buf.join(" ") });
  }

  return blocks;
}

/**
 * 解析列表：按缩进建立层级。
 * 同级项归并；缩进更深的行去掉两级缩进后递归解析为子块
 * （支持「列表项下挂段落/代码块/嵌套列表」）。
 */
function parseList(
  lines: string[],
  start: number,
  ordered: boolean,
): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  const marker = (l: string) => RE_UL.exec(l) ?? RE_OL.exec(l);
  const baseIndent = marker(lines[start])![1].length;
  let i = start;

  while (i < lines.length) {
    const m = marker(lines[i]);
    if (!m) break;
    // 缩进更浅/更深，或序号与无序混排（视为同级新项）→ 结束本层
    if (m[1].length !== baseIndent) break;
    const isOrdered = !!RE_OL.exec(lines[i]);
    if (isOrdered !== ordered) break;

    let text = m[3];
    let checked: boolean | null = null;
    const task = RE_TASK.exec(text);
    if (task) {
      checked = task[1].toLowerCase() === "x";
      text = task[2];
    }
    i++;

    // 收集本项的子行：更深的缩进或普通续行，直到遇到同级/更浅的列表标记
    const sub: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const cm = marker(cur);
      if (cm) {
        if (cm[1].length > baseIndent) {
          // 去掉一层基准缩进（+2）后交给子块解析，保留相对层级
          sub.push(cur.replace(/^\s{2}/, ""));
          i++;
          continue;
        }
        break;
      }
      if (!cur.trim()) {
        // 空行：仅当其后仍是本项的子内容时才保留，否则结束本项
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nm = j < lines.length ? marker(lines[j]) : null;
        if (j < lines.length && (!nm || nm[1].length > baseIndent)) {
          sub.push("");
          i = j;
          continue;
        }
        break;
      }
      sub.push(cur.trim());
      i++;
    }

    items.push({ text, checked, children: sub.length ? parseBlocks(sub) : [] });
  }

  return { items, next: i };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${keyPrefix}-b${idx}`;
    switch (b.type) {
      case "heading": {
        const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
        return (
          <Tag className={`md-h md-h${b.level}`} key={key}>
            {renderInline(b.text, key)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p className="md-p" key={key}>
            {renderInline(b.text, key)}
          </p>
        );
      case "code":
        return (
          <pre className="md-pre" key={key}>
            <code>{b.code}</code>
          </pre>
        );
      case "hr":
        return <hr className="md-hr" key={key} />;
      case "quote":
        return (
          <blockquote className="md-quote" key={key}>
            {renderBlocks(parseBlocks(b.lines), key)}
          </blockquote>
        );
      case "table":
        return (
          <div className="md-table-wrap" key={key}>
            <table className="md-table">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.aligns[j] === "c" ? "center" : b.aligns[j] === "r" ? "right" : "left" }}>
                      {renderInline(c, `${key}-h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.head.map((_, ci) => (
                      <td
                        key={ci}
                        style={{ textAlign: b.aligns[ci] === "c" ? "center" : b.aligns[ci] === "r" ? "right" : "left" }}
                      >
                        {renderInline(r[ci] ?? "", `${key}-r${ri}c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag className={`md-list${b.ordered ? " ordered" : ""}`} key={key}>
            {b.items.map((it, j) => (
              <li className={`md-li${it.checked !== null ? " task" : ""}`} key={j}>
                {it.checked !== null ? (
                  <span className={`md-check${it.checked ? " on" : ""}`} aria-hidden>
                    {it.checked ? "☑" : "☐"}
                  </span>
                ) : null}
                <span className="md-li-text">{renderInline(it.text, `${key}-i${j}`)}</span>
                {it.children.length ? (
                  <div className="md-li-children">{renderBlocks(it.children, `${key}-i${j}`)}</div>
                ) : null}
              </li>
            ))}
          </Tag>
        );
      }
      default:
        return null;
    }
  });
}

/** Markdown 正文渲染入口 */
export default function Markdown({ text }: { text: string }) {
  const cleaned = stripSafeHtml(text.replace(/\r\n?/g, "\n"));
  const blocks = parseBlocks(cleaned.split("\n"));
  return <div className="md-body">{renderBlocks(blocks, "md")}</div>;
}
