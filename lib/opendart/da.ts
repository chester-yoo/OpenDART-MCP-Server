/**
 * 감가상각비·상각비(D&A) 추출 — 상장사 정기보고서(사업·반기·분기) 대상.
 *
 * 3단계로 찾는다. 앞 단계에서 감가상각비(또는 D&A 합계)를 찾으면 거기서 멈춘다.
 *   1) api   : 정형 재무제표 API(fnlttSinglAcntAll) 현금흐름표 조정 항목. 금액이 원 단위라 단위 문제가 없다.
 *   2) xbrl  : 공시 원문의 XBRL 태그(<TE ACODE ...>). 단위는 각 숫자의 ADECIMAL 로 판단(0=원, -3=천원, -6=백만원).
 *   3) table : 태그 없는 원문 표. 주석의 "현금흐름 조정" 또는 "비용의 성격별 분류" 표에서 행 이름으로 찾고,
 *              단위는 표 앞의 "(단위 : 천원)" 표시로 판단한다. needs_review=true 로 표시한다.
 *
 * current = 당기 누적(사업보고서는 FY, 반기·분기는 기초부터 누적), prior = 전기 동기 누적.
 * 결과 금액은 백만원 단위(소수 1자리).
 */
import { getBinary, getJson } from "./client";
import { isNoData } from "./errors";
import { decodeXml } from "@/lib/tools/document";

export type DaComponent = "total" | "dep" | "rou" | "invprop" | "amort";

export interface DaPeriod {
  value: number | null; // 백만원
  components: Partial<Record<DaComponent, number>>; // 백만원
}

export interface DaResult {
  rcept_no: string | null;
  corp_code: string;
  fs_div: "CFS" | "OFS";
  unit: "백만원";
  method: "api" | "xbrl" | "table" | null;
  current: DaPeriod;
  prior: DaPeriod;
  source: string;
  unit_basis: string;
  needs_review: boolean;
  tried: string[];
}

const LABEL_KO: Record<DaComponent, string> = {
  total: "감가상각비와 상각비(합계)",
  dep: "감가상각비",
  rou: "사용권자산상각비",
  invprop: "투자부동산상각비",
  amort: "무형자산상각비",
};

// ------------------------------------------------------------------ 공통: 항목명 분류

const EXCLUDE_NAME = /대손|상각후원가|할인|할증|이자|손상|환입|처분|선급|이연|채권|전환권|사채|누계|재고|폐기/;

/** XBRL 코드(접두어 제외)로 판정. 기능별 일부(판관비·매출원가 등)나 누계액·손상은 제외. */
export function classifyCode(code: string): DaComponent | null {
  const c = code.toLowerCase();
  if (/sellinggeneral|costofsales|researchanddevelopment|impairment|accumulated|amortisedcost|discount|premium|baddebt|doubtful|reversal|disposal/.test(c)) return null;
  if (/depreciationandamortisation/.test(c)) return "total";
  if (/includingrightofuse/.test(c) && /deprec/.test(c)) return "dep";
  if (/rightofuse/.test(c) && /deprec|amortis/.test(c)) return "rou";
  if (/investmentproperty/.test(c) && /deprec/.test(c)) return "invprop";
  if (/amortis/.test(c)) return "amort";
  if (/deprec/.test(c)) return "dep";
  return null;
}

/** 계정명(+선택적 코드)으로 D&A 구성요소를 판정. 해당 없으면 null. */
export function classify(name: string, code = ""): DaComponent | null {
  const n = name.replace(/\s+/g, "").replace(/[()（）\[\]]/g, "");
  if (code) {
    const byCode = classifyCode(code);
    if (byCode) return n && EXCLUDE_NAME.test(n) ? null : byCode;
  }
  if (!n || EXCLUDE_NAME.test(n)) return null;
  if (/감가상각비(와|및|과)(무형자산)?상각비/.test(n)) return "total";
  if (/사용권자산/.test(n) && /상각/.test(n)) return "rou";
  if (/투자부동산/.test(n) && /상각/.test(n)) return "invprop";
  if (/무형자산.*상각|개발비.*상각|^상각비(에대한조정|조정)?$/.test(n)) return "amort";
  if (/^(유형자산)?감가상각비(,?유형자산)?(에대한조정|조정|비용)?$/.test(n)) return "dep";
  return null;
}

function sumComponents(parts: Partial<Record<DaComponent, number>>): number | null {
  if (parts.total != null) return parts.total;
  if (parts.dep == null) return null; // 감가상각비 없이 일부만 있으면 불완전 → 다음 단계로
  return (parts.dep ?? 0) + (parts.rou ?? 0) + (parts.invprop ?? 0) + (parts.amort ?? 0);
}

const toMil = (won: number) => Math.round((won / 1e6) * 10) / 10;

function period(parts: Partial<Record<DaComponent, number>>): DaPeriod {
  const comps: Partial<Record<DaComponent, number>> = {};
  for (const [k, v] of Object.entries(parts)) if (v != null) comps[k as DaComponent] = toMil(v);
  const total = sumComponents(parts);
  return { value: total == null ? null : toMil(total), components: comps };
}

function describe(parts: Partial<Record<DaComponent, number>>): string {
  if (parts.total != null) return LABEL_KO.total;
  return (Object.keys(parts) as DaComponent[]).filter((k) => parts[k] != null).map((k) => LABEL_KO[k]).join(" + ");
}

function parseNum(s: string): number | null {
  const t = s.replace(/<[^>]+>/g, "").replace(/&nbsp;| /g, "").replace(/[,\s]/g, "").trim();
  if (!t || /^[-－–—]$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^[-△▲]/.test(t);
  const v = Number(t.replace(/[()△▲\-]/g, ""));
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

// ------------------------------------------------------------------ 1단계: 정형 API

interface ApiRow { sj_div: string; account_id: string; account_nm: string; thstrm_amount?: string; frmtrm_amount?: string; thstrm_add_amount?: string; frmtrm_add_amount?: string }

async function stageApi(
  corp_code: string, bsns_year: string, reprt_code: string, fs_div: string, key: string
): Promise<{ cur: Partial<Record<DaComponent, number>>; pri: Partial<Record<DaComponent, number>> } | null> {
  const data = await getJson("fnlttSinglAcntAll", { corp_code, bsns_year, reprt_code, fs_div }, key).catch((e) => {
    if (String(e).includes("013")) return null;
    throw e;
  });
  if (!data || isNoData(data.status as string)) return null;
  const rows = (data.list as ApiRow[]) || [];
  const cur: Partial<Record<DaComponent, number>> = {};
  const pri: Partial<Record<DaComponent, number>> = {};
  for (const r of rows) {
    if (r.sj_div !== "CF") continue;
    const comp = classify(r.account_nm, r.account_id === "-표준계정코드 미사용-" ? "" : r.account_id);
    if (!comp) continue;
    const c = parseNum(r.thstrm_amount ?? r.thstrm_add_amount ?? "");
    const p = parseNum(r.frmtrm_amount ?? r.frmtrm_add_amount ?? "");
    if (c != null) cur[comp] = (cur[comp] ?? 0) + Math.abs(c);
    if (p != null) pri[comp] = (pri[comp] ?? 0) + Math.abs(p);
  }
  return { cur, pri };
}

// ------------------------------------------------------------------ 원문 다운로드

export async function fetchDocument(rcept_no: string, key: string): Promise<string> {
  const buf = new Uint8Array(await getBinary("document", { rcept_no }, key));
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    const t = decodeXml(buf).text;
    try {
      const j = JSON.parse(t) as { status: string; message: string };
      throw new Error(`[OpenDART ${j.status}] ${j.message} (endpoint: document)`);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error("Unexpected non-ZIP response from document.xml endpoint.");
      throw e;
    }
  }
  const { unzipSync } = await import("fflate");
  const files = unzipSync(buf);
  return Object.values(files).map((b) => decodeXml(b).text).join("\n");
}

// ------------------------------------------------------------------ 2단계: XBRL 태그

const TE_RE = /<TE\b([^>]*)>([\s\S]*?)<\/TE>/gi;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const CTX_RE = /^(C|P)FY(\d{4})d([A-Za-z0-9]+?)(?:_(.*))?$/;
const AXIS_C = "ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_ConsolidatedMember";
const AXIS_S = "ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_SeparateMember";

interface Fact { code: string; cp: "C" | "P"; per: string; dims: string; v: number; scale: number }

function facts(text: string): Fact[] {
  const out: Fact[] = [];
  for (const m of text.matchAll(TE_RE)) {
    const a: Record<string, string> = {};
    for (const am of m[1].matchAll(ATTR_RE)) a[am[1]] = am[2];
    if (!a.ACODE || !a.ACONTEXT) continue;
    const cm = CTX_RE.exec(a.ACONTEXT);
    if (!cm) continue;
    const v = parseNum(m[2]);
    if (v == null) continue;
    const dec = a.ADECIMAL != null && /^-?\d+$/.test(a.ADECIMAL) ? Number(a.ADECIMAL) : NaN;
    if (!Number.isFinite(dec)) continue; // 단위 근거 없는 값은 쓰지 않는다
    out.push({ code: a.ACODE, cp: cm[1] as "C" | "P", per: cm[3], dims: cm[4] ?? "", v, scale: Math.pow(10, -dec) });
  }
  return out;
}

const isAccum = (per: string) => { const p = per.toUpperCase(); return p === "FY" || p === "Y" || p.endsWith("A"); };

/** 연결/별도 축만 있는 값(+ dart 보고금액 멤버 허용). 별도만 공시하는 회사는 차원 없는 값도 허용. */
function plainDims(dims: string, fs_div: string): boolean {
  const axis = fs_div === "OFS" ? AXIS_S : AXIS_C;
  const rest = dims.startsWith(axis) ? dims.slice(axis.length) : null;
  if (rest === "" ) return true;
  if (rest != null && /^_[\w-]*Axis_dart_ReportedAmountMember$/.test(rest)) return true;
  if (fs_div === "OFS" && dims === "") return true;
  return false;
}

function stageXbrl(text: string, fs_div: string) {
  const fs = facts(text).filter((f) => isAccum(f.per) && plainDims(f.dims, fs_div));
  const pick = (cp: "C" | "P", adjOnly: boolean) => {
    const parts: Partial<Record<DaComponent, number>> = {};
    const units = new Set<number>();
    let depIncludesRou = false;
    for (const f of fs) {
      if (f.cp !== cp) continue;
      const isAdj = /AdjustmentsFor/i.test(f.code);
      if (adjOnly !== isAdj) continue;
      const bare = f.code.replace(/^.*?_/, "");
      const comp = classifyCode(bare);
      // 같은 구성요소에 서로 다른 태그가 있으면 첫 값만 (중복 합산 방지)
      if (!comp || parts[comp] != null) continue;
      parts[comp] = Math.abs(f.v) * f.scale;
      units.add(f.scale);
      if (comp === "dep" && /includingrightofuse/i.test(bare)) depIncludesRou = true;
    }
    if (depIncludesRou) delete parts.rou; // 사용권자산 포함 감가상각비면 사용권자산상각비를 따로 더하지 않는다
    return { parts, units };
  };
  // 우선순위: D&A 합계 태그(현금흐름 조정 → 비용) → 구성요소 합(현금흐름 조정 → 비용).
  // 구성요소 일부(예: 사용권자산상각비)가 태그 없이 공시되면 합산이 과소해지므로 합계 태그를 먼저 쓴다.
  const adj = { c: pick("C", true), p: pick("P", true), kind: "현금흐름 조정" };
  const exp = { c: pick("C", false), p: pick("P", false), kind: "비용" };
  const only = (parts: Partial<Record<DaComponent, number>>) => (parts.total != null ? { total: parts.total } : parts);
  for (const s of [adj, exp]) {
    if (s.c.parts.total != null)
      return { cur: only(s.c.parts), pri: only(s.p.parts), kind: `${s.kind} 합계 태그`, units: s.c.units };
  }
  for (const s of [adj, exp]) {
    if (sumComponents(s.c.parts) != null)
      return { cur: s.c.parts, pri: s.p.parts, kind: `${s.kind} 구성요소 태그`, units: s.c.units };
  }
  return null;
}

// ------------------------------------------------------------------ 3단계: 태그 없는 표

const UNIT_RE = /단위\s*[:：]\s*(백만원|천원|원)/g;
const UNIT_SCALE: Record<string, number> = { 원: 1, 천원: 1e3, 백만원: 1e6 };
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();

/** 연결(CFS)/별도(OFS) 재무제표 주석 구간만 잘라낸다. 못 찾으면 전체. */
export function notesSection(text: string, fs_div: string): string {
  const titles = [...text.matchAll(/<TITLE\b[^>]*>([\s\S]*?)<\/TITLE>/gi)].map((m) => ({ at: m.index!, t: plain(m[1]) }));
  const isTarget = (t: string) => (fs_div === "OFS" ? /재무제표\s*주석/.test(t) && !/연결/.test(t) : /연결재무제표\s*주석/.test(t));
  const i = titles.findIndex((x) => isTarget(x.t));
  if (i < 0) return text;
  const end = titles.slice(i + 1).find((x) => /^\s*\d+\.\s/.test(x.t) || /^[IVX]+\./.test(x.t));
  const sec = text.slice(titles[i].at, end ? end.at : undefined);
  // 주석 본문이 제목 뒤 별도 구간으로 붙는 문서가 있어, 구간이 비정상적으로 짧으면 제목부터 끝까지 본다.
  return sec.length < 20_000 ? text.slice(titles[i].at) : sec;
}

type Parts = Partial<Record<DaComponent, number>>;
type TableHit = { prio: number; cur: Parts; pri: Parts; unit: string; at: number };

/** 주석 표들을 순서대로 읽어 D&A 행이 있는 표를 돌려준다. */
function scanTables(sec: string): TableHit[] {
  const hits: TableHit[] = [];
  for (const tm of sec.matchAll(/<TABLE\b[\s\S]*?<\/TABLE>/gi)) {
    // DART 원문은 "(단위 : 원)"을 본 표 바로 앞의 작은 표에 따로 넣는 경우가 많아, 직전 표까지 포함해 앞 맥락을 본다.
    // 다만 표 분류는 바로 앞 150자(주석 제목 + 단위 표시)로만 해서 앞 주석의 제목이 섞이지 않게 한다.
    const before = plain(sec.slice(Math.max(0, tm.index! - 6000), tm.index!)).slice(-400);
    const table = tm[0];
    const tplain = plain(table);
    const ctx = before.slice(-150) + " " + tplain.slice(0, 120);
    const prio = /성격별/.test(ctx)
      ? 2
      : /현금흐름|창출된\s*현금|창출\s*현금|조정\s*항목|비용\s*등의\s*가산|수익.{0,3}비용.{0,3}조정/.test(ctx)
        ? 1
        : 0;
    if (!prio) continue;

    const units = [...(before + " " + tplain.slice(0, 300)).matchAll(UNIT_RE)];
    if (!units.length) continue;
    const unit = units[units.length - 1][1];
    const scale = UNIT_SCALE[unit];

    const rows = [...table.matchAll(/<TR\b[\s\S]*?<\/TR>/gi)].map((r) =>
      [...r[0].matchAll(/<T[DHE]\b[^>]*>([\s\S]*?)<\/T[DHE]>/gi)].map((c) => plain(c[1]))
    );
    // 누적 열 위치: 머리행에 "누적"이 있으면 그 열만 쓴다 (분기 성격별 표: 3개월/누적/3개월/누적)
    const header = rows.find((r) => r.some((c) => /누적/.test(c)) && r.some((c) => /3\s*개월/.test(c)));
    const cur: Partial<Record<DaComponent, number>> = {};
    const pri: Partial<Record<DaComponent, number>> = {};
    for (const r of rows) {
      if (!r.length) continue;
      const comp = classify(r[0]);
      if (!comp) continue;
      const nums = r.slice(1).map(parseNum).filter((v): v is number => v != null);
      let c: number | undefined, p: number | undefined;
      if (header && nums.length === 4) { c = nums[1]; p = nums[3]; }
      else if (nums.length === 2) { c = nums[0]; p = nums[1]; }
      else if (nums.length === 1) { c = nums[0]; }
      else continue; // 열이 많은 표(유형자산 변동표 등)는 기간을 특정할 수 없어 쓰지 않는다
      if (cur[comp] == null && c != null) cur[comp] = Math.abs(c) * scale;
      if (pri[comp] == null && p != null) pri[comp] = Math.abs(p) * scale;
    }
    if (sumComponents(cur) != null) hits.push({ prio, cur, pri, unit, at: tm.index! });
  }
  return hits;
}

export function stageTable(text: string, fs_div: string) {
  const hits = scanTables(notesSection(text, fs_div));
  for (const prio of [1, 2]) {
    const i = hits.findIndex((h) => h.prio === prio);
    if (i < 0) continue;
    const h = hits[i];
    let pri = h.pri;
    // 당기·전기가 별도 표로 나뉜 경우(당분기 표 → 전분기 표): 바로 다음 같은 유형 표의 값을 전기로 쓴다.
    if (sumComponents(pri) == null) {
      const next = hits[i + 1];
      if (next && next.prio === prio && sumComponents(next.pri) == null) pri = next.cur;
    }
    return { cur: h.cur, pri, unit: h.unit, ctx: prio === 1 ? "현금흐름 조정 주석 표" : "비용의 성격별 분류 주석 표" };
  }
  return null;
}

// ------------------------------------------------------------------ 접수번호 찾기

const REPORT_NAME: Record<string, { kind: string; months: string[] }> = {
  "11011": { kind: "사업보고서", months: ["12"] },
  "11012": { kind: "반기보고서", months: ["06"] },
  "11013": { kind: "분기보고서", months: ["03"] },
  "11014": { kind: "분기보고서", months: ["09"] },
};

export async function findReceiptNo(corp_code: string, bsns_year: string, reprt_code: string, key: string): Promise<string | null> {
  const y = Number(bsns_year);
  const spec = REPORT_NAME[reprt_code];
  const data = await getJson(
    "list",
    { corp_code, bgn_de: `${y}0101`, end_de: `${y + 1}1231`, pblntf_ty: "A", last_reprt_at: "Y", page_count: "100" },
    key
  ).catch(() => null);
  const list = ((data?.list as Array<{ report_nm: string; rcept_no: string }>) || []).filter(
    (r) => r.report_nm.includes(spec.kind) && spec.months.some((m) => r.report_nm.includes(`(${bsns_year}.${m})`))
  );
  return list[0]?.rcept_no ?? null;
}

// ------------------------------------------------------------------ 진입점

export async function getDA(opts: {
  corp_code: string; bsns_year: string; reprt_code: string; fs_div: "CFS" | "OFS"; rcept_no?: string; key: string;
}): Promise<DaResult> {
  const { corp_code, bsns_year, reprt_code, fs_div, key } = opts;
  const tried: string[] = [];
  const base = { corp_code, fs_div, unit: "백만원" as const };

  // 1) 정형 API
  const api = await stageApi(corp_code, bsns_year, reprt_code, fs_div, key);
  if (api && sumComponents(api.cur) != null) {
    return {
      ...base, rcept_no: opts.rcept_no ?? null, method: "api", current: period(api.cur), prior: period(api.pri),
      source: `정형 재무제표 API 현금흐름표: ${describe(api.cur)}`, unit_basis: "API 금액(원 단위)", needs_review: false, tried: ["api"],
    };
  }
  tried.push(api ? "api(현금흐름표 본문에 감가상각비 없음)" : "api(데이터 없음)");

  // 2)·3) 원문
  const rcept_no = opts.rcept_no || (await findReceiptNo(corp_code, bsns_year, reprt_code, key));
  if (!rcept_no) {
    return { ...base, rcept_no: null, method: null, current: period({}), prior: period({}), source: "공시 접수번호를 찾지 못함", unit_basis: "", needs_review: true, tried };
  }
  const text = await fetchDocument(rcept_no, key);

  const x = stageXbrl(text, fs_div);
  if (x) {
    const unitNames = [...x.units].map((s) => (s === 1 ? "원" : s === 1e3 ? "천원" : s === 1e6 ? "백만원" : `×${s}`)).join("/");
    return {
      ...base, rcept_no, method: "xbrl", current: period(x.cur), prior: period(x.pri),
      source: `공시 원문 XBRL ${x.kind}: ${describe(x.cur)}`, unit_basis: `XBRL ADECIMAL (${unitNames})`, needs_review: false,
      tried: [...tried, "xbrl"],
    };
  }
  tried.push("xbrl(태그 없음)");

  const t = stageTable(text, fs_div);
  if (t) {
    return {
      ...base, rcept_no, method: "table", current: period(t.cur), prior: period(t.pri),
      source: `공시 원문 ${t.ctx}(태그 없음): ${describe(t.cur)}`, unit_basis: `표 단위 표시 (단위: ${t.unit})`, needs_review: true,
      tried: [...tried, "table"],
    };
  }
  tried.push("table(해당 표 없음)");
  return { ...base, rcept_no, method: null, current: period({}), prior: period({}), source: "D&A를 찾지 못함", unit_basis: "", needs_review: true, tried };
}
