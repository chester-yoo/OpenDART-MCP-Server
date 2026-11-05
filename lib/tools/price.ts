import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { priceAverage } from "@/lib/price/naver";

export function registerPriceTools(server: McpServer) {
  server.registerTool(
    "stock_price_average",
    {
      title: "기간 평균 종가 (N개월 단순평균)",
      description:
        "Average daily CLOSE price of KRX-listed stocks over the N months ending on a date (default 3 months), " +
        "e.g. for '3개월 평균주가' trading multiples. Source: 네이버 금융 일별 시세(수정주가, KRX 시세와 동일).\n" +
        "\n" +
        "Window = (end_date − N months + 1 day) ~ end_date. Simple average of closes; days with zero volume are excluded.\n" +
        "Returns compact JSON per code: from, to, days, avg_close(원), last_close, last_date, excluded_zero_volume. " +
        "Set include_daily=true only if you need every daily close (much larger output).\n" +
        "\n" +
        "Args: stock_codes (1–20), end_date YYYYMMDD, months (default 3), include_daily (default false)",
      inputSchema: {
        stock_codes: z
          .array(z.string().regex(/^[0-9A-Z]{6}$/))
          .min(1)
          .max(20)
          .describe("6-digit KRX stock codes (1–20)"),
        end_date: z.string().regex(/^\d{8}$/).describe("Last day of the window, YYYYMMDD (e.g. valuation date)"),
        months: z.number().int().min(1).max(12).default(3).describe("Window length in months (default 3)"),
        include_daily: z.boolean().default(false).describe("Also return [date, close] for each trading day"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ stock_codes, end_date, months, include_daily }) => {
      const m = months ?? 3;
      const results = await Promise.all(
        stock_codes.map((c) => priceAverage(c, end_date, m, include_daily ?? false))
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ unit: "원", months: m, source: "네이버 금융 일별 시세(수정주가)", prices: results }),
          },
        ],
      };
    }
  );
}
