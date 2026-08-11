import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBinary, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";

// 응답 크기 제한 (토큰 과다 사용 방지). 필요시 조정하세요.
const MAX_CHARS = 100_000;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_get_document",
    {
      title: "공시서류 원본 (Disclosure Document Original)",
      description:
        "Download the original disclosure document (감사보고서, 사업보고서 등) and return its raw XML text content. " +
        "Use rcept_no obtained from opendart_search_disclosure.\n" +
        "Args: rcept_no (14-digit receipt number), api_key (optional)",
      inputSchema: {
        rcept_no: z
          .string()
          .length(14)
          .describe("14-digit receipt number (접수번호), e.g. from opendart_search_disclosure results"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations,
    },
    async ({ rcept_no, api_key }) => {
      try {
        const key = resolveApiKey(api_key);
        const buffer = await getBinary("document", { rcept_no }, key);
        const uint8 = new Uint8Array(buffer);

        // ZIP magic bytes(PK) 확인. 아니라면 JSON 에러 응답일 가능성이 높음.
        if (uint8[0] !== 0x50 || uint8[1] !== 0x4b) {
          const text = new TextDecoder("utf-8").decode(uint8);
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
        for (const name of fileNames) {
          const decoded = new TextDecoder("utf-8").decode(unzipped[name]);
          parts.push(`=== ${name} ===\n${decoded}`);
        }
        let fullText = parts.join("\n\n");

        let truncatedNote = "";
        if (fullText.length > MAX_CHARS) {
          fullText = fullText.slice(0, MAX_CHARS);
          truncatedNote = `\n\n[...내용이 길어 ${MAX_CHARS.toLocaleString()}자에서 잘렸습니다. 전체 원문이 필요하면 브라우저에서 직접 다운로드하세요: https://opendart.fss.or.kr/api/document.xml?crtfc_key=YOUR_KEY&rcept_no=${rcept_no}]`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `## 공시서류 원본 (접수번호: ${rcept_no})\n\n${fullText}${truncatedNote}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
