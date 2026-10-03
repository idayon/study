// 알리오(공공데이터포털) 채용공시 API → 내 기준으로 걸러서 alio.json 저장
// 실행: ALIO_KEY=인증키 node scripts/alio.js   (GitHub Actions에서 매일 실행)
const fs = require("fs");
const path = require("path");

const API = "https://apis.data.go.kr/1051000/recruitment/list";
const ROOT = path.join(__dirname, "..");

function ymd(s){
  // "20261007" / "2026-10-07" / "2026.10.07" → "2026-10-07"
  const d = String(s || "").replace(/[^0-9]/g, "");
  return d.length >= 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : "";
}
const norm = s => String(s || "").replace(/\s+/g, "");
const has = (text, words) => words.some(w => String(text || "").includes(w));

// 공고 하나를 채점. 제외면 null
function score(it, cfg){
  const org = it.instNm || "";
  const regions = String(it.workRgnNmLst || "").split(/[,·/]/).map(s => s.trim()).filter(Boolean);
  const hire = it.hireTypeNmLst || "";
  const reasons = [];

  if (cfg.excludeReplacement && it.replmprYn === "Y") return null;
  // 정규직·채용형 인턴이 하나라도 있어야 통과 (비정규직만, 무기계약직만인 공고는 제외)
  if (!hire.split(",").map(s => s.trim()).some(h => cfg.allowHire.includes(h))) return null;
  if (cfg.excludeCareerOnly && /경력/.test(it.recrutSeNm || "") && !/신입/.test(it.recrutSeNm || "")) return null;
  if (has(org, cfg.excludeOrgKeywords)) return null;
  const title = String(it.recrutPbancTtl || "").split(org).join(" ");   // 기관명 속 '연구원' 같은 단어는 빼고 검사
  if (has(title, cfg.excludeTitle)) return null;

  const regionKeys = Object.keys(cfg.regionScore);
  let best = regions.length ? 0 : cfg.regionDefault, bestName = "";
  regions.forEach(r => {
    const k = regionKeys.find(k => r.includes(k));
    const v = k ? cfg.regionScore[k] : cfg.regionDefault;
    if (v > best){ best = v; bestName = k || r; }
  });
  if (!regions.length) bestName = "근무지 미기재";

  const topCities = ["서울", "세종", "대전", "부산"];
  let hqWarn = "";
  for (const [city, orgs] of Object.entries(cfg.excludeOrgs)){
    if (city.startsWith("_")) continue;
    if (!orgs.some(o => norm(org).includes(norm(o)))) continue;
    if (!regions.some(r => has(r, topCities))) return null;
    if (!has(it.recrutPbancTtl, topCities)) hqWarn = `⚠️ 본사 ${city} — 실제 근무지 확인`;
  }

  let s = best; reasons.push(`${bestName} ${best}`);
  const bonusKey = Object.keys(cfg.regionBonus).find(k => !k.startsWith("_") && regions.some(r => r.includes(k)));
  if (bonusKey){ s += cfg.regionBonus[bonusKey]; reasons.push(`지역인재 가점 +${cfg.regionBonus[bonusKey]}`); }
  const finance = cfg.financeOrgs.some(o => norm(org).includes(norm(o)));
  if (finance){ s += cfg.financeBonus; reasons.push(`금융공기업 +${cfg.financeBonus}`); }
  if (has(it.ncsCdNmLst, cfg.officeNcs)){ s += cfg.officeBonus; reasons.push(`사무 +${cfg.officeBonus}`); }

  if (s < cfg.minScore && !finance) return null;
  return { score: s, reasons, finance, intern: /인턴/.test(hire), hqWarn };
}

function toJob(it, sc){
  const end = ymd(it.pbancEndYmd), start = ymd(it.pbancBgngYmd);
  const memo = [
    `추천 ${sc.score}점 · ${sc.reasons.join(" · ")}`,
    [it.hireTypeNmLst, it.recrutSeNm, it.recrutNope ? `${it.recrutNope}명` : "", it.workRgnNmLst].filter(Boolean).join(" · "),
    sc.intern ? "⚠️ 채용형 인턴 — 인턴 기간 급여 확인" : "",
    sc.hqWarn
  ].filter(Boolean).join("\n");
  return {
    id: "alio-" + it.recrutPblntSn,
    org: it.instNm,
    role: it.recrutPbancTtl,
    status: "새 공고",
    auto: true,
    score: sc.score,
    url: it.srcUrl || `https://job.alio.go.kr/recruitview.do?idx=${it.recrutPblntSn}`,
    memo,
    stages: [{ type: "서류", label: "원서 마감", date: end, note: start ? `접수 ${start.slice(5).replace("-", ".")}~` : "" }]
  };
}

function pick(items, cfg, today){
  const out = [];
  items.forEach(it => {
    const end = ymd(it.pbancEndYmd);
    if (!end || end < today) return;
    const sc = score(it, cfg);
    if (sc) out.push(toJob(it, sc));
  });
  out.sort((a, b) => a.stages[0].date < b.stages[0].date ? -1 : a.stages[0].date > b.stages[0].date ? 1 : b.score - a.score);
  return out;
}

// 공공데이터포털 API가 잠깐 끊기는 일이 잦아서, 실패하면 간격을 늘려 가며 다시 시도한다
async function getJSON(url, tries = 4){
  let last;
  for (let i = 0; i < tries; i++){
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 15000 * (i + 1)));
    }
  }
  throw last;
}

async function fetchAll(key){
  const items = [];
  for (let page = 1; page <= 20; page++){
    const q = new URLSearchParams({ serviceKey: key, resultType: "json", ongoingYn: "Y", numOfRows: "100", pageNo: String(page) });
    const j = await getJSON(`${API}?${q}`);
    if (j.resultCode !== 200 && j.resultCode !== 0) throw new Error(`API ${j.resultCode} ${j.resultMsg}`);
    const rows = (j.result || []).map(r => r.item || r);
    items.push(...rows);
    if (!rows.length || items.length >= (j.totalCount || 0)) break;
  }
  return items;
}

async function main(){
  const key = process.env.ALIO_KEY;
  if (!key) throw new Error("ALIO_KEY 환경변수가 없습니다");
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "alio-filter.json"), "utf8"));
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString();
  const items = await fetchAll(key);
  const jobs = pick(items, cfg, kst.slice(0, 10));
  const out = { updated: kst.slice(0, 16).replace("T", " "), fetched: items.length, jobs };
  fs.writeFileSync(path.join(ROOT, "alio.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`진행 중 공고 ${items.length}건 → 추천 ${jobs.length}건`);
}

if (typeof module !== "undefined") module.exports = { score, pick, ymd };
// 알리오 쪽 장애로 못 받아오면 기존 alio.json을 그대로 두고 경고만 남긴다 (실패 메일·빈 목록 방지)
if (typeof require !== "undefined" && require.main === module) main().catch(e => {
  console.log(`::warning::알리오 공고를 받아오지 못해 기존 목록을 유지합니다: ${e.message}`);
  if (e.message.includes("ALIO_KEY")) process.exit(1);
});
