import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";
import { searchCompanies } from "@/lib/opendart/cache";
import { getDA } from "@/lib/opendart/da";

export function registerDaTools(server: McpServer) {
  server.registerTool(
    "opendart_get_da",
    {
      title: "감가상각비·상각비 (D&A for EBITDA)",
      description:
        "Get depreciation & amortisation (D&A) of a LISTED company from a periodic report (사업/반기/분기보고서), " +
        "for EBITDA = 영업이익 + D&A. Returns a small JSON (백만원), never the document itself.\n" +
        "\n" +
        "Lookup order (stops at the first that finds 감가상각비):\n" +
        "  1) api   — 정형 재무제표 API 현금흐름표 조정 항목 (원 단위, 단위 문제 없음)\n" +
        "  2) xbrl  — 공시 원문 XBRL 태그. 단위는 숫자별 ADECIMAL 로 판단\n" +
        "  3) table — 태그 없는 원문 주석 표(현금흐름 조정 / 비용의 성격별 분류). needs_review=true\n" +
        "\n" +
        "current = 당기 누적(FY 또는 기초부터 누적), prior = 전기 동기 누적. " +
        "value = total 이 있으면 total, 없으면 dep + rou + invprop + amort.\n" +
        "\n" +
        "Args: stock_code or corp_code, bsns_year, reprt_code, fs_div, rcept_no (optional but recommended), api_key",
      inputSchema: {
        stock_code: z.string().regex(/^\d{6}$/).optional().describe("6-digit KRX stock code (either this or corp_code)"),
        corp_code: z.string().length(8).optional().describe("8-digit DART company code (either this or stock_code)"),
        bsns_year: z.string().regex(/^\d{4}$/).describe("Fiscal year the report COVERS (YYYY)"),
        reprt_code: z
          .enum(["11011", "11012", "11013", "11014"])
          .describe("11011=Annual, 11012=Semi-annual, 11013=Q1, 11014=Q3"),
        fs_div: z.enum(["CFS", "OFS"]).default("CFS").describe("CFS=Consolidated (default), OFS=Separate"),
        rcept_no: z
          .string()
          .length(14)
          .optional()
          .describe("14-digit receipt number of the same report. If omitted it is looked up (Dec fiscal year only)."),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ stock_code, corp_code, bsns_year, reprt_code, fs_div, rcept_no, api_key }) => {
      try {
        const key = resolveApiKey(api_key);
        let corp = corp_code;
        if (!corp && stock_code) corp = (await searchCompanies(stock_code))[0]?.corp_code;
        if (!corp) {
          return {
            content: [{ type: "text" as const, text: "stock_code 또는 corp_code 가 필요합니다(종목코드로 기업을 찾지 못함)." }],
            isError: true,
          };
        }
        const res = await getDA({ corp_code: corp, bsns_year, reprt_code, fs_div: fs_div ?? "CFS", rcept_no, key });
        return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
