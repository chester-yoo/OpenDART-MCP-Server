/**
 * 상장 주식 일별 종가 — 네이버 금융 차트 API (api.stock.naver.com, 수정주가 기준).
 * KRX(pykrx) 일별 시세와 일치함을 확인(2026-11, 19종목 × 61~65거래일 전부 동일).
 *
 * 기간 평균은 종가 단순평균이며, 거래량 0인 날(거래정지 등)은 제외한다.
 */

export interface DailyRow {
  date: string; // YYYYMMDD
  close: number;
  volume: number;
}

export interface PriceAverage {
  code: string;
  from: string;
  to: string;
  days: number; // 평균에 쓴 거래일 수
  avg_close: number | null; // 원
  last_close: number | null; // 기간 마지막 거래일 종가
  last_date: string | null;
  excluded_zero_volume: number;
  daily?: [string, number][]; // include_daily=true 일 때만 [YYYYMMDD, 종가]
  error?: string;
}

const UA = "Mozilla/5.0 (compatible; opendart-mcp)";

export async function fetchDaily(code: string, from: string, to: string): Promise<DailyRow[]> {
  const url =
    `https://api.stock.naver.com/chart/domestic/item/${encodeURIComponent(code)}/day` +
    `?startDateTime=${from}0000&endDateTime=${to}2359`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!res.ok) throw new Error(`네이버 차트 응답 오류 HTTP ${res.status}`);
  const data = (await res.json()) as Array<{
    localDate: string;
    closePrice: number;
    accumulatedTradingVolume: number;
  }>;
  if (!Array.isArray(data)) throw new Error("네이버 차트 응답 형식 오류");
  return data
    .filter((x) => x && x.localDate >= from && x.localDate <= to)
    .map((x) => ({ date: x.localDate, close: Number(x.closePrice), volume: Number(x.accumulatedTradingVolume) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** end(YYYYMMDD)에서 months 개월 전 + 1일. 월말 넘침은 그 달 말일로 맞춘다(30일 → 2월 28일 등). */
export function startOfWindow(end: string, months: number): string {
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(4, 6));
  const d = Number(end.slice(6, 8));
  let mm = m - months;
  let yy = y;
  while (mm <= 0) {
    mm += 12;
    yy -= 1;
  }
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const start = new Date(Date.UTC(yy, mm - 1, Math.min(d, last)));
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function priceAverage(
  code: string,
  end: string,
  months: number,
  includeDaily: boolean
): Promise<PriceAverage> {
  const from = startOfWindow(end, months);
  const base: PriceAverage = {
    code, from, to: end, days: 0, avg_close: null, last_close: null, last_date: null, excluded_zero_volume: 0,
  };
  try {
    const rows = await fetchDaily(code, from, end);
    if (!rows.length) return { ...base, error: "시세 없음(상장 전·상장폐지·코드 오류 가능)" };
    const valid = rows.filter((r) => r.volume > 0);
    const avg = valid.length ? valid.reduce((s, r) => s + r.close, 0) / valid.length : null;
    const last = rows[rows.length - 1];
    return {
      ...base,
      days: valid.length,
      avg_close: avg === null ? null : Math.round(avg * 100) / 100,
      last_close: last.close,
      last_date: last.date,
      excluded_zero_volume: rows.length - valid.length,
      ...(includeDaily ? { daily: valid.map((r) => [r.date, r.close] as [string, number]) } : {}),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
