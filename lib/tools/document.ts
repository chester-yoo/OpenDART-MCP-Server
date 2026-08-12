From 571682907dbd358903e6698a5f151c251c780171 Mon Sep 17 00:00:00 2001
From: Claude <noreply@anthropic.com>
Date: Wed, 12 Aug 2026 04:38:08 +0000
Subject: [PATCH] =?UTF-8?q?fix(document):=20EUC-KR=20=EC=9B=90=EB=AC=B8=20?=
 =?UTF-8?q?=EC=98=A4=EB=94=94=EC=BD=94=EB=94=A9=20=EC=88=98=EC=A0=95=20?=
 =?UTF-8?q?=EB=B0=8F=20keyword/offset=20=ED=8C=8C=EB=9D=BC=EB=AF=B8?=
 =?UTF-8?q?=ED=84=B0=20=EC=B6=94=EA=B0=80?=
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

opendart_get_document 에 두 가지 문제가 있었다.

1. 인코딩: TextDecoder("utf-8") 하드코딩. DART 원문 중 일부는 XML 선언에
   encoding="utf-8" 이라고 적어놓고 실제 바이트는 EUC-KR 이라 한글이 전부
   깨진다. (예: rcept_no=20220331002215 → utf-8 디코딩 시 치환문자 41,474개,
   euc-kr 디코딩 시 0개)
   → 선언을 1순위 후보로 쓰되 맹신하지 않고, U+FFFD 개수로 판정해
     utf-8 / euc-kr 중 성공하는 쪽을 채택한다. 런타임이 euc-kr 을 지원하지
     않는 경우는 try/catch 로 보호.

2. 절단: MAX_CHARS=100,000 에서 자르고 끝이라 뒷부분에 도달할 방법이 없었다.
   재무제표 본표는 앞쪽이지만 주석(감가상각비, 비용의 성격별 분류, 차입금)은
   15만자 지점 이후라 구조적으로 항상 잘린다.
   (감가상각비 첫 등장: 20220331002215 → 143,034자 / 20260327001226 → 153,180자)
   → 상한을 무작정 올리는 대신 파라미터 추가:
     - keyword: 매치 주변 구간만 반환 (최대 8곳, 겹치는 구간 병합). 권장 경로
     - offset: 잘렸을 때 응답이 알려주는 next_offset 으로 이어 읽기
     - max_chars: 기본 100,000 유지, 하드캡 200,000

CLAUDE.md 에 비상장사(정기보고서 미제출) 재무데이터는 pblntf_ty="F" 로
감사보고서를 찾아 원문을 읽어야 한다는 안내와 keyword 우선 사용 지침을 추가.

검증: npx tsc --noEmit 통과. 실제 원문 2건으로 디코딩 함수 실행하여
FY2021 euc-kr / FY2025 utf-8 판정 및 감가상각비 발췌 정상 확인 (Node 22).
Vercel 배포 런타임의 euc-kr 지원 여부는 배포 후 확인 필요.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MC8keahCMj4DXCw98tBEHf
---
 CLAUDE.md             |  16 ++++
 lib/tools/document.ts | 176 +++++++++++++++++++++++++++++++++++++++---
 2 files changed, 180 insertions(+), 12 deletions(-)

diff --git a/CLAUDE.md b/CLAUDE.md
index 5ef885e..dfb281c 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -69,6 +69,22 @@
 | 소송 | `opendart_lawsuit` |
 | 회생절차 | `opendart_rehabilitation` |
 
+### 공시서류 원문
+| 상황 | 도구 |
+|------|------|
+| 감사보고서·사업보고서 원문 XML | `opendart_get_document` |
+
+**비상장사 재무데이터**: 정기보고서 미제출사(비상장 외부감사 대상)는 재무제표 API
+(`opendart_full_financial_statement` 등)에 데이터가 없습니다. 이 경우
+`opendart_search_disclosure(pblntf_ty: "F")` 로 감사보고서를 찾아
+`opendart_get_document` 로 원문을 읽으세요.
+
+**원문이 길 때**: 재무제표 본표는 문서 앞부분에 있지만 주석(감가상각비, 비용의 성격별 분류,
+차입금 내역)은 15만자 지점 이후에 나오는 경우가 많아 기본 반환 상한에서 잘립니다.
+- 필요한 주석만 뽑을 때: `keyword: "감가상각비"` — 매치 주변 구간만 반환. **이 방식을 우선 사용**
+- 순차로 다 읽을 때: 응답에 표시된 `next_offset` 값을 `offset` 에 넣어 재호출
+- 상한 조정: `max_chars` (기본 100,000 / 최대 200,000)
+
 ### 감사/채무
 | 상황 | 도구 |
 |------|------|
diff --git a/lib/tools/document.ts b/lib/tools/document.ts
index ab17045..e4273e9 100644
--- a/lib/tools/document.ts
+++ b/lib/tools/document.ts
@@ -3,11 +3,50 @@ import { z } from "zod";
 import { getBinary, resolveApiKey } from "@/lib/opendart/client";
 import { formatApiError } from "@/lib/opendart/errors";
 
-// 응답 크기 제한 (토큰 과다 사용 방지). 필요시 조정하세요.
-const MAX_CHARS = 100_000;
+// 응답 크기 제한 (토큰 과다 사용 방지).
+// 기본값은 보수적으로 두고, 호출자가 max_chars 로 상향하거나
+// keyword/offset 으로 필요한 구간만 뽑아 가도록 한다.
+const DEFAULT_MAX_CHARS = 100_000;
+const HARD_MAX_CHARS = 200_000;
+const DEFAULT_WINDOW = 20_000;
+const MAX_KEYWORD_HITS = 8;
 
 const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
 
+/**
+ * DART 원문 ZIP 안의 XML 은 문서에 따라 UTF-8 또는 EUC-KR 로 인코딩되어 있다.
+ * XML 선언의 encoding 속성을 먼저 보고, 없거나 디코딩 결과가 깨지면
+ * (U+FFFD 치환문자 비율로 판정) 다른 인코딩으로 재시도한다.
+ */
+function decodeXml(bytes: Uint8Array): { text: string; encoding: string } {
+  // XML 선언은 ASCII 영역이므로 앞부분만 latin1 로 훑어 encoding 속성을 찾는다.
+  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
+  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
+
+  const candidates: string[] = [];
+  if (declared) candidates.push(declared === "euc-kr" || declared === "ks_c_5601-1987" ? "euc-kr" : declared);
+  for (const fallback of ["utf-8", "euc-kr"]) {
+    if (!candidates.includes(fallback)) candidates.push(fallback);
+  }
+
+  let best: { text: string; encoding: string; bad: number } | null = null;
+  for (const enc of candidates) {
+    let text: string;
+    try {
+      text = new TextDecoder(enc).decode(bytes);
+    } catch {
+      continue; // 런타임이 해당 인코딩을 지원하지 않으면 다음 후보로
+    }
+    // 치환문자(U+FFFD) 개수로 디코딩 성공 여부를 판정한다.
+    const bad = (text.match(/�/g) || []).length;
+    if (bad === 0) return { text, encoding: enc };
+    if (!best || bad < best.bad) best = { text, encoding: enc, bad };
+  }
+
+  if (!best) return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(forced)" };
+  return { text: best.text, encoding: `${best.encoding}(치환문자 ${best.bad}자)` };
+}
+
 export function registerDocumentTools(server: McpServer) {
   server.registerTool(
     "opendart_get_document",
@@ -16,17 +55,52 @@ export function registerDocumentTools(server: McpServer) {
       description:
         "Download the original disclosure document (감사보고서, 사업보고서 등) and return its raw XML text content. " +
         "Use rcept_no obtained from opendart_search_disclosure.\n" +
-        "Args: rcept_no (14-digit receipt number), api_key (optional)",
+        "\n" +
+        "IMPORTANT: full documents often exceed the size limit. Financial statement tables usually appear " +
+        "early, but 주석(notes) — where 감가상각비, 비용의 성격별 분류, 차입금 내역 live — appear far into the " +
+        "document and get cut off. To reach them, either:\n" +
+        "  - pass `keyword` (e.g. \"감가상각비\") to return only the sections around each match, or\n" +
+        "  - page through with `offset` (the response reports the next offset when truncated).\n" +
+        "Prefer `keyword` — it is far cheaper than paging the whole document.\n" +
+        "\n" +
+        "Args: rcept_no (14-digit receipt number), keyword, window, offset, max_chars, api_key (all optional)",
       inputSchema: {
         rcept_no: z
           .string()
           .length(14)
           .describe("14-digit receipt number (접수번호), e.g. from opendart_search_disclosure results"),
+        keyword: z
+          .string()
+          .optional()
+          .describe(
+            "Return only the regions surrounding this string (case-insensitive) instead of the document head. " +
+              "Use this to reach 주석 deep in the document, e.g. \"감가상각비\", \"비용의 성격별\", \"차입금\"."
+          ),
+        window: z
+          .number()
+          .int()
+          .min(1_000)
+          .max(60_000)
+          .optional()
+          .describe(`Characters returned around each keyword match (default ${DEFAULT_WINDOW}). Only used with keyword.`),
+        offset: z
+          .number()
+          .int()
+          .min(0)
+          .optional()
+          .describe("Start position in the decoded document. Use the next_offset reported by a truncated response."),
+        max_chars: z
+          .number()
+          .int()
+          .min(1_000)
+          .max(HARD_MAX_CHARS)
+          .optional()
+          .describe(`Maximum characters to return (default ${DEFAULT_MAX_CHARS}, hard cap ${HARD_MAX_CHARS}).`),
         api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
       },
       annotations,
     },
-    async ({ rcept_no, api_key }) => {
+    async ({ rcept_no, keyword, window, offset, max_chars, api_key }) => {
       try {
         const key = resolveApiKey(api_key);
         const buffer = await getBinary("document", { rcept_no }, key);
@@ -34,7 +108,7 @@ export function registerDocumentTools(server: McpServer) {
 
         // ZIP magic bytes(PK) 확인. 아니라면 JSON 에러 응답일 가능성이 높음.
         if (uint8[0] !== 0x50 || uint8[1] !== 0x4b) {
-          const text = new TextDecoder("utf-8").decode(uint8);
+          const text = decodeXml(uint8).text;
           try {
             const json = JSON.parse(text) as { status: string; message: string };
             return {
@@ -68,23 +142,101 @@ export function registerDocumentTools(server: McpServer) {
 
         // 보통 파일 하나(XML). 여러 개인 경우 모두 이어붙임.
         const parts: string[] = [];
+        const encodings: string[] = [];
         for (const name of fileNames) {
-          const decoded = new TextDecoder("utf-8").decode(unzipped[name]);
+          const { text: decoded, encoding } = decodeXml(unzipped[name]);
+          encodings.push(`${name}: ${encoding}`);
           parts.push(`=== ${name} ===\n${decoded}`);
         }
-        let fullText = parts.join("\n\n");
+        const fullText = parts.join("\n\n");
+        const totalLen = fullText.length;
+        const limit = Math.min(max_chars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
+
+        const meta =
+          `## 공시서류 원본 (접수번호: ${rcept_no})\n` +
+          `- 전체 길이: ${totalLen.toLocaleString()}자 / 인코딩: ${encodings.join(", ")}\n`;
+
+        // ------------------------------------------------------------ keyword 모드
+        if (keyword) {
+          const win = window ?? DEFAULT_WINDOW;
+          const haystack = fullText.toLowerCase();
+          const needle = keyword.toLowerCase();
+
+          const hits: number[] = [];
+          let from = 0;
+          while (hits.length < MAX_KEYWORD_HITS) {
+            const at = haystack.indexOf(needle, from);
+            if (at === -1) break;
+            hits.push(at);
+            from = at + needle.length;
+          }
+
+          if (hits.length === 0) {
+            return {
+              content: [
+                {
+                  type: "text" as const,
+                  text:
+                    meta +
+                    `- keyword: "${keyword}" — 원문에서 찾지 못했습니다.\n\n` +
+                    `다른 표기를 시도해 보세요 (예: "감가상각비" ↔ "감가상각", "성격별" ↔ "비용의 성격별 분류"). ` +
+                    `keyword 없이 offset 으로 페이징할 수도 있습니다.`,
+                },
+              ],
+            };
+          }
+
+          // 겹치는 구간은 하나로 합친다.
+          const ranges: Array<[number, number]> = [];
+          for (const at of hits) {
+            const start = Math.max(0, at - Math.floor(win / 2));
+            const end = Math.min(totalLen, at + needle.length + Math.floor(win / 2));
+            const last = ranges[ranges.length - 1];
+            if (last && start <= last[1]) last[1] = Math.max(last[1], end);
+            else ranges.push([start, end]);
+          }
+
+          let budget = limit;
+          const chunks: string[] = [];
+          for (const [start, end] of ranges) {
+            if (budget <= 0) break;
+            const take = Math.min(end - start, budget);
+            budget -= take;
+            chunks.push(`--- [offset ${start.toLocaleString()} ~ ${(start + take).toLocaleString()}] ---\n` + fullText.slice(start, start + take));
+          }
+
+          const more = hits.length >= MAX_KEYWORD_HITS ? ` (상위 ${MAX_KEYWORD_HITS}건만 표시)` : "";
+          return {
+            content: [
+              {
+                type: "text" as const,
+                text:
+                  meta +
+                  `- keyword: "${keyword}" — ${hits.length}건 매치${more}, 구간 ${ranges.length}개 반환\n\n` +
+                  chunks.join("\n\n"),
+              },
+            ],
+          };
+        }
+
+        // ------------------------------------------------------------ offset 페이징 모드
+        const start = Math.min(offset ?? 0, totalLen);
+        const slice = fullText.slice(start, start + limit);
+        const nextOffset = start + slice.length;
 
-        let truncatedNote = "";
-        if (fullText.length > MAX_CHARS) {
-          fullText = fullText.slice(0, MAX_CHARS);
-          truncatedNote = `\n\n[...내용이 길어 ${MAX_CHARS.toLocaleString()}자에서 잘렸습니다. 전체 원문이 필요하면 브라우저에서 직접 다운로드하세요: https://opendart.fss.or.kr/api/document.xml?crtfc_key=YOUR_KEY&rcept_no=${rcept_no}]`;
+        let note = "";
+        if (nextOffset < totalLen) {
+          note =
+            `\n\n[...${nextOffset.toLocaleString()}자 지점에서 잘렸습니다. 남은 분량 ${(totalLen - nextOffset).toLocaleString()}자.\n` +
+            ` 이어 읽기: offset=${nextOffset} 로 다시 호출하세요.\n` +
+            ` 특정 주석만 필요하면 keyword 를 쓰는 편이 훨씬 저렴합니다. 예: keyword="감가상각비"]`;
         }
 
         return {
           content: [
             {
               type: "text" as const,
-              text: `## 공시서류 원본 (접수번호: ${rcept_no})\n\n${fullText}${truncatedNote}`,
+              text: meta + `- 반환 구간: ${start.toLocaleString()} ~ ${nextOffset.toLocaleString()}자\n\n${slice}${note}`,
             },
           ],
         };
-- 
2.43.0
