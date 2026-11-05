import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBinary, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";

// 응답 크기 제한 (토큰 과다 사용 방지).
// 기본값은 보수적으로 두고, 호출자가 max_chars 로 상향하거나
// keyword/offset 으로 필요한 구간만 뽑아 가도록 한다.
const DEFAULT_MAX_CHARS = 100_000;
const HARD_MAX_CHARS = 200_000;
const DEFAULT_WINDOW = 20_000;
const MAX_KEYWORD_HITS = 8;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * DART 원문 ZIP 안의 XML 은 문서에 따라 UTF-8 또는 EUC-KR 로 인코딩되어 있다.
 * XML 선언의 encoding 속성을 먼저 보고, 없거나 디코딩 결과가 깨지면
 * (U+FFFD 치환문자 비율로 판정) 다른 인코딩으로 재시도한다.
 */
export function decodeXml(bytes: Uint8Array): { text: string; encoding: string } {
  // XML 선언은 ASCII 영역이므로 앞부분만 latin1 로 훑어 encoding 속성을 찾는다.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();

  const candidates: string[] = [];
  if (declared) candidates.push(declared === "euc-kr" || declared === "ks_c_5601-1987" ? "euc-kr" : declared);
  for (const fallback of ["utf-8", "euc-kr"]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  let best: { text: string; encoding: string; bad: number } | null = null;
  for (const enc of candidates) {
    let text: string;
    try {
      text = new TextDecoder(enc).decode(bytes);
    } catch {
      continue; // 런타임이 해당 인코딩을 지원하지 않으면 다음 후보로
    }
    // 치환문자(U+FFFD) 개수로 디코딩 성공 여부를 판정한다.
    const bad = (text.match(/�/g) || []).length;
    if (bad === 0) return { text, encoding: enc };
    if (!best || bad < best.bad) best = { text, encoding: enc, bad };
  }

  if (!best) return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(forced)" };
  return { text: best.text, encoding: `${best.encoding}(치환문자 ${best.bad}자)` };
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_get_document",
    {
      title: "공시서류 원본 (Disclosure Document Original)",
      description:
        "Download the original disclosure document (감사보고서, 사업보고서 등) and return its raw XML text content. " +
        "Use rcept_no obtained from opendart_search_disclosure.\n" +
        "\n" +
        "IMPORTANT: full documents often exceed the size limit. Financial statement tables usually appear " +
        "early, but 주석(notes) — where 감가상각비, 비용의 성격별 분류, 차입금 내역 live — appear far into the " +
        "document and get cut off. To reach them, either:\n" +
        "  - pass `keyword` (e.g. \"감가상각비\") to return only the sections around each match, or\n" +
        "  - page through with `offset` (the response reports the next offset when truncated).\n" +
        "Prefer `keyword` — it is far cheaper than paging the whole document.\n" +
        "\n" +
        "Args: rcept_no (14-digit receipt number), keyword, window, offset, max_chars, api_key (all optional)",
      inputSchema: {
        rcept_no: z
          .string()
          .length(14)
          .describe("14-digit receipt number (접수번호), e.g. from opendart_search_disclosure results"),
        keyword: z
          .string()
          .optional()
          .describe(
            "Return only the regions surrounding this string (case-insensitive) instead of the document head. " +
              "Use this to reach 주석 deep in the document, e.g. \"감가상각비\", \"비용의 성격별\", \"차입금\"."
          ),
        window: z
          .number()
          .int()
          .min(1_000)
          .max(60_000)
          .optional()
          .describe(`Characters returned around each keyword match (default ${DEFAULT_WINDOW}). Only used with keyword.`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start position in the decoded document. Use the next_offset reported by a truncated response."),
        max_chars: z
          .number()
          .int()
          .min(1_000)
          .max(HARD_MAX_CHARS)
          .optional()
          .describe(`Maximum characters to return (default ${DEFAULT_MAX_CHARS}, hard cap ${HARD_MAX_CHARS}).`),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations,
    },
    async ({ rcept_no, keyword, window, offset, max_chars, api_key }) => {
      try {
        const key = resolveApiKey(api_key);
        const buffer = await getBinary("document", { rcept_no }, key);
        const uint8 = new Uint8Array(buffer);

        // ZIP magic bytes(PK) 확인. 아니라면 JSON 에러 응답일 가능성이 높음.
        if (uint8[0] !== 0x50 || uint8[1] !== 0x4b) {
          const text = decodeXml(uint8).text;
          try {
            const json = JSON.parse(text) as { status: string; message: string };
            return {
              content: [
                {
                  type: "text" as const,
                  text: `[OpenDART ${json.status}] ${json.message} (endpoint: document)`,
                },
              ],
              isError: true,
            };
          } catch {
            return {
              content: [{ type: "text" as const, text: "Unexpected non-ZIP response from document.xml endpoint." }],
              isError: true,
            };
          }
        }

        // fflate로 압축 해제 (기존 corp-codes 업데이트 스크립트와 동일 패턴)
        const { unzipSync } = await import("fflate");
        const unzipped = unzipSync(uint8);
        const fileNames = Object.keys(unzipped);

        if (fileNames.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No files found inside ZIP archive." }],
            isError: true,
          };
        }

        // 보통 파일 하나(XML). 여러 개인 경우 모두 이어붙임.
        const parts: string[] = [];
        const encodings: string[] = [];
        for (const name of fileNames) {
          const { text: decoded, encoding } = decodeXml(unzipped[name]);
          encodings.push(`${name}: ${encoding}`);
          parts.push(`=== ${name} ===\n${decoded}`);
        }
        const fullText = parts.join("\n\n");
        const totalLen = fullText.length;
        const limit = Math.min(max_chars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS);

        const meta =
          `## 공시서류 원본 (접수번호: ${rcept_no})\n` +
          `- 전체 길이: ${totalLen.toLocaleString()}자 / 인코딩: ${encodings.join(", ")}\n`;

        // ------------------------------------------------------------ keyword 모드
        if (keyword) {
          const win = window ?? DEFAULT_WINDOW;
          const haystack = fullText.toLowerCase();
          const needle = keyword.toLowerCase();

          const hits: number[] = [];
          let from = 0;
          while (hits.length < MAX_KEYWORD_HITS) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            hits.push(at);
            from = at + needle.length;
          }

          if (hits.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    meta +
                    `- keyword: "${keyword}" — 원문에서 찾지 못했습니다.\n\n` +
                    `다른 표기를 시도해 보세요 (예: "감가상각비" ↔ "감가상각", "성격별" ↔ "비용의 성격별 분류"). ` +
                    `keyword 없이 offset 으로 페이징할 수도 있습니다.`,
                },
              ],
            };
          }

          // 겹치는 구간은 하나로 합친다.
          const ranges: Array<[number, number]> = [];
          for (const at of hits) {
            const start = Math.max(0, at - Math.floor(win / 2));
            const end = Math.min(totalLen, at + needle.length + Math.floor(win / 2));
            const last = ranges[ranges.length - 1];
            if (last && start <= last[1]) last[1] = Math.max(last[1], end);
            else ranges.push([start, end]);
          }

          let budget = limit;
          const chunks: string[] = [];
          for (const [start, end] of ranges) {
            if (budget <= 0) break;
            const take = Math.min(end - start, budget);
            budget -= take;
            chunks.push(`--- [offset ${start.toLocaleString()} ~ ${(start + take).toLocaleString()}] ---\n` + fullText.slice(start, start + take));
          }

          const more = hits.length >= MAX_KEYWORD_HITS ? ` (상위 ${MAX_KEYWORD_HITS}건만 표시)` : "";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  meta +
                  `- keyword: "${keyword}" — ${hits.length}건 매치${more}, 구간 ${ranges.length}개 반환\n\n` +
                  chunks.join("\n\n"),
              },
            ],
          };
        }

        // ------------------------------------------------------------ offset 페이징 모드
        const start = Math.min(offset ?? 0, totalLen);
        const slice = fullText.slice(start, start + limit);
        const nextOffset = start + slice.length;

        let note = "";
        if (nextOffset < totalLen) {
          note =
            `\n\n[...${nextOffset.toLocaleString()}자 지점에서 잘렸습니다. 남은 분량 ${(totalLen - nextOffset).toLocaleString()}자.\n` +
            ` 이어 읽기: offset=${nextOffset} 로 다시 호출하세요.\n` +
            ` 특정 주석만 필요하면 keyword 를 쓰는 편이 훨씬 저렴합니다. 예: keyword="감가상각비"]`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: meta + `- 반환 구간: ${start.toLocaleString()} ~ ${nextOffset.toLocaleString()}자\n\n${slice}${note}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
