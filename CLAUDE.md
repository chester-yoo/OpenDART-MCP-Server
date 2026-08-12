# OpenDART MCP Server - AI 도구 사용 가이드

## 기본 워크플로우

1. **회사 찾기**: `opendart_search_company`로 corp_code를 먼저 조회
2. **정보 조회**: corp_code를 사용하여 원하는 도구 호출

## 상황별 도구 선택

### 회사 찾기
| 상황 | 도구 |
|------|------|
| 회사명/종목코드로 기업코드 찾기 | `opendart_search_company` |
| 기업 기본정보 (대표이사, 주소, 업종 등) | `opendart_get_company_info` |
| 공시 검색 | `opendart_search_disclosure` |

### 재무 정보
| 상황 | 도구 | 파라미터 참고 |
|------|------|-------------|
| 매출/영업이익/순이익 등 주요 계정 | `opendart_single_financial_accounts` | fs_div: CFS=연결, OFS=별도 |
| 전체 재무제표 (BS/IS/CF 모든 항목) | `opendart_full_financial_statement` | |
| 여러 회사 재무 비교 (최대 100개) | `opendart_multi_financial_accounts` | corp_code를 콤마로 구분 |
| 수익성/안정성/성장성 지표 | `opendart_single_financial_index` | |
| 여러 회사 지표 비교 | `opendart_multi_financial_index` | |
| XBRL 계정 분류 체계 | `opendart_xbrl_taxonomy` | sj_div: BS1, IS1, CF1 등 |
| 배당 정보 | `opendart_dividend_info` | |

### 주주/임원 정보
| 상황 | 도구 |
|------|------|
| 최대주주 현황 | `opendart_largest_shareholder` |
| 최대주주 변동 | `opendart_largest_shareholder_change` |
| 소액주주 현황 | `opendart_minority_shareholder` |
| 임원 현황 (직위, 담당업무) | `opendart_executive_status` |
| 직원 현황 (인원, 급여) | `opendart_employee_status` |
| 보수 상위 5인 | `opendart_top5_compensation` |
| 이사/감사 개인별 보수 | `opendart_individual_compensation` |
| 이사/감사 전체 보수 | `opendart_total_compensation` |
| 사외이사 현황 | `opendart_outside_director` |

### 주식/자본 정보
| 상황 | 도구 |
|------|------|
| 발행주식 총수 | `opendart_total_shares` |
| 증자/감자 현황 | `opendart_stock_issuance_status` |
| 자기주식 취득/처분 | `opendart_treasury_stock` |

### 대량보유/임원 보유
| 상황 | 도구 |
|------|------|
| 대량보유 (5%+ 지분) | `opendart_major_stockholding` |
| 임원 주식 보유 | `opendart_executive_stockholding` |

### 주요사항보고서 (기간 검색: bgn_de ~ end_de)
| 상황 | 도구 |
|------|------|
| 유상증자 결정 | `opendart_capital_increase` |
| 무상증자 결정 | `opendart_free_capital_increase` |
| 감자 결정 | `opendart_capital_decrease` |
| 합병 결정 | `opendart_merger` |
| 회사분할 | `opendart_division` |
| 전환사채(CB) 발행 | `opendart_convertible_bond` |
| 신주인수권부사채(BW) | `opendart_bond_with_warrant` |
| 교환사채(EB) | `opendart_exchangeable_bond` |
| 자기주식 취득 결정 | `opendart_treasury_acquisition_decision` |
| 자기주식 처분 결정 | `opendart_disposal_treasury_stock` |
| 영업양수 | `opendart_business_acquisition` |
| 영업양도 | `opendart_business_transfer` |
| 소송 | `opendart_lawsuit` |
| 회생절차 | `opendart_rehabilitation` |

### 공시서류 원문
| 상황 | 도구 |
|------|------|
| 감사보고서·사업보고서 원문 XML | `opendart_get_document` |

**비상장사 재무데이터**: 정기보고서 미제출사(비상장 외부감사 대상)는 재무제표 API
(`opendart_full_financial_statement` 등)에 데이터가 없습니다. 이 경우
`opendart_search_disclosure(pblntf_ty: "F")` 로 감사보고서를 찾아
`opendart_get_document` 로 원문을 읽으세요.

**원문이 길 때**: 재무제표 본표는 문서 앞부분에 있지만 주석(감가상각비, 비용의 성격별 분류,
차입금 내역)은 15만자 지점 이후에 나오는 경우가 많아 기본 반환 상한에서 잘립니다.
- 필요한 주석만 뽑을 때: `keyword: "감가상각비"` — 매치 주변 구간만 반환. **이 방식을 우선 사용**
- 순차로 다 읽을 때: 응답에 표시된 `next_offset` 값을 `offset` 에 넣어 재호출
- 상한 조정: `max_chars` (기본 100,000 / 최대 200,000)

### 감사/채무
| 상황 | 도구 |
|------|------|
| 감사인/감사의견 | `opendart_auditor_opinion` |
| 회계감사 계약 | `opendart_audit_service_contract` |
| 채무증권 발행실적 | `opendart_debt_securities` |
| 회사채 잔액 | `opendart_corporate_bond` |
| 타법인 출자 현황 | `opendart_investment_in_others` |

## ⚠️ 연도 해석 규칙 (중요)

`bsns_year`는 보고서가 **다루는 사업연도**이며, 제출 연도가 아닙니다.
- "2025년 사업보고서" → `bsns_year: "2025"` (O)
- "2025년 사업보고서" → `bsns_year: "2024"` (X, 절대 1을 빼지 마세요)
- 2025년 사업보고서는 2025 사업연도를 다루며, 2026년 3월경에 제출됩니다.

## 파라미터 참고

### reprt_code (보고서 구분)
| 코드 | 의미 |
|------|------|
| 11011 | 사업보고서 (연간) |
| 11012 | 반기보고서 |
| 11013 | 1분기보고서 |
| 11014 | 3분기보고서 |

### fs_div (재무제표 구분)
| 코드 | 의미 |
|------|------|
| CFS | 연결재무제표 (기본값, 추천) |
| OFS | 별도재무제표 |

### 날짜 형식
- `bgn_de`, `end_de`: YYYYMMDD (예: "20240101")
- `bsns_year`: YYYY (예: "2024")
