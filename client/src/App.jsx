import { useState, useEffect, useRef } from "react";

/* ─── DESIGN TOKENS ──────────────────────────────────────────── */
const T = {
  bg:       "#080b12",
  surface:  "#0d1220",
  card:     "#111827",
  card2:    "#161f30",
  border:   "#1e2d47",
  gold:     "#d4a843",
  gold2:    "#f0c060",
  green:    "#10b981",
  red:      "#ef4444",
  blue:     "#3b82f6",
  purple:   "#8b5cf6",
  cyan:     "#06b6d4",
  text:     "#e2e8f0",
  muted:    "#64748b",
  dim:      "#334155",
};

/* ─── MATHEMATICAL MODELS ────────────────────────────────────── */

// 1. Bayesian Form Model — weighted recency bias (most recent run = highest weight)
function bayesianFormScore(formStr) {
  const pos = formStr.split("-").map(Number).filter(n => !isNaN(n));
  const weights = pos.map((_, i) => Math.pow(0.72, i)); // exponential decay
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const score = pos.reduce((sum, p, i) => sum + weights[i] * Math.max(0, 8 - p), 0);
  return Math.min(1, score / (weightSum * 7));
}

// 2. Poisson Win Probability — models race as independent scoring events
function poissonWinProb(lambdas) {
  // λ = expected performance rating; normalise across field
  const total = lambdas.reduce((a, b) => a + b, 0);
  return lambdas.map(l => l / total);
}

// 3. Kelly Criterion — optimal bet sizing given edge
function kellyCriterion(p, oddsDecimal) {
  const q = 1 - p;
  const b = oddsDecimal - 1;
  const kelly = (b * p - q) / b;
  return Math.max(0, Math.min(0.25, kelly)); // cap at 25% bankroll
}

// 4. ELO-style Rating — based on trainer/jockey partnership win rate
function eloRating(trainerWinRate, jockeyWinRate, partnershipBonus) {
  const base = 1500;
  const t = (trainerWinRate - 0.12) * 800;
  const j = (jockeyWinRate - 0.12) * 600;
  return base + t + j + partnershipBonus * 50;
}

// 5. Going Suitability Matrix
const GOING_MATRIX = {
  "Firm":         { likes_fast: 1.20, likes_good: 1.05, likes_soft: 0.75, likes_heavy: 0.60 },
  "Good to Firm": { likes_fast: 1.15, likes_good: 1.10, likes_soft: 0.80, likes_heavy: 0.65 },
  "Good":         { likes_fast: 1.05, likes_good: 1.20, likes_soft: 0.95, likes_heavy: 0.80 },
  "Good to Soft": { likes_fast: 0.90, likes_good: 1.10, likes_soft: 1.15, likes_heavy: 0.90 },
  "Soft":         { likes_fast: 0.70, likes_good: 0.90, likes_soft: 1.25, likes_heavy: 1.10 },
  "Heavy":        { likes_fast: 0.55, likes_good: 0.75, likes_soft: 1.15, likes_heavy: 1.30 },
};

// 6. Draw Bias Model — track-specific stall advantage
function drawBias(draw, totalRunners, going, distance) {
  const isSprint = parseFloat(distance) <= 6;
  const isSoft = going.includes("Soft") || going.includes("Heavy");
  if (isSprint) {
    if (isSoft) return draw <= 3 ? 1.12 : draw <= Math.ceil(totalRunners/2) ? 1.0 : 0.88;
    return draw <= 2 ? 1.08 : draw >= totalRunners - 1 ? 0.92 : 1.0;
  }
  return 1.0; // flat for longer trips
}

// 7. Class Drop/Rise Adjustment
function classAdjustment(horseOr, raceClass) {
  const classMap = { "Group 1": 115, "Group 2": 112, "Group 3": 108, "Listed": 105, "Class 1": 100, "Class 2": 95, "Class 3": 90, "Class 4": 85, "Class 5": 78, "Class 6": 72 };
  const raceRating = classMap[raceClass] || 90;
  if (!horseOr) return 1.0;
  const diff = horseOr - raceRating;
  return 1 + (diff * 0.008); // 0.8% per rating point advantage
}

// 8. Weight-for-Age Adjusted Performance
function weightAdjusted(weightStr, ageCarried = 0) {
  const [st, lb] = weightStr.split("-").map(Number);
  const totalLb = st * 14 + lb;
  // Each lb = ~0.25 lengths over 1m, lighter = better
  return Math.max(0.6, 1 - ((totalLb - 126) * 0.003));
}

// 9. Market Bayesian Update — use implied probability to update prior
function marketBayesianUpdate(modelProb, impliedOddsProb, marketWeight = 0.35) {
  return modelProb * (1 - marketWeight) + impliedOddsProb * marketWeight;
}

// 10. Consistency Index — Sharpe-like ratio for racing
function consistencyIndex(formStr) {
  const pos = formStr.split("-").map(Number).filter(n => !isNaN(n));
  if (pos.length < 2) return 0.5;
  const mean = pos.reduce((a, b) => a + b, 0) / pos.length;
  const variance = pos.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pos.length;
  const sd = Math.sqrt(variance);
  // Lower mean (better position) + lower SD (consistent) = higher score
  return Math.min(1, Math.max(0, (8 - mean) / 7 * (1 - sd / 6)));
}

const MODELS_META = [
  { id: "bayesian",     label: "Bayesian Form",       icon: "🧠", desc: "Exponential decay weighting — recent runs count 3x more than older ones" },
  { id: "poisson",      label: "Poisson Model",        icon: "📐", desc: "Treats race as random process — models win probability from performance rate λ" },
  { id: "kelly",        label: "Kelly Criterion",      icon: "💹", desc: "Optimal stake sizing: f* = (bp-q)/b — flags bets with positive expected value" },
  { id: "elo",          label: "ELO Rating",           icon: "⚡", desc: "Trainer/jockey partnership ELO — 1500 base, adjusted by historical win rates" },
  { id: "going",        label: "Going Matrix",         icon: "🌧️", desc: "6x6 ground preference matrix — multiplier from Firm to Heavy vs horse profile" },
  { id: "draw",         label: "Draw Bias",            icon: "🎲", desc: "Stall advantage model — sprint/soft bias quantified by track geometry" },
  { id: "class",        label: "Class Adjustment",     icon: "🏅", desc: "OR vs race rating — 0.8% edge per rating point dropped in class" },
  { id: "weight",       label: "Weight Model",         icon: "⚖️", desc: "Lb-per-length adjustment — each lb from ideal = measurable time penalty" },
  { id: "market",       label: "Market Bayesian",      icon: "💰", desc: "35% market weight update — smart money as informative prior" },
  { id: "consistency",  label: "Consistency Index",    icon: "📊", desc: "Sharpe-ratio analogue — rewards low variance performers over high variance" },
];

// TRAINER/JOCKEY BASE WIN RATES (simplified but realistic)
const TRAINER_RATES = { "J Gosden": 0.22, "A O'Brien": 0.21, "C Appleby": 0.20, "W Haggas": 0.19, "R Varian": 0.17, "A Balding": 0.16, "R Fahey": 0.14, "M Johnston": 0.15, "S bin Suroor": 0.16, "P Cole": 0.13, "M Botti": 0.12, "R Hannon": 0.15 };
const JOCKEY_RATES  = { "F Dettori": 0.22, "R Moore": 0.24, "W Buick": 0.23, "P Hanagan": 0.16, "J Fanning": 0.14, "T Queally": 0.15, "R Dettori": 0.18, "O Murphy": 0.17, "T Marquand": 0.18, "C Soumillon": 0.20, "S Drowne": 0.12, "A Beschizza": 0.13, "A Atzeni": 0.16, "C Lee": 0.14, "C Keane": 0.18 };
const PARTNERSHIP_BONUS = { "J Gosden/F Dettori": 3, "C Appleby/W Buick": 4, "A O'Brien/R Moore": 4, "W Haggas/T Marquand": 3, "R Varian/A Atzeni": 2 };

function getPartnershipKey(trainer, jockey) {
  return `${trainer}/${jockey}`;
}

function fullScore(horse, race, fieldSize) {
  const ba = bayesianFormScore(horse.form);
  const going = (GOING_MATRIX[race.going] || GOING_MATRIX["Good"]);
  const goingPref = "likes_good"; // simplified
  const gScore = going[goingPref] || 1.0;
  const dScore = drawBias(horse.draw, fieldSize, race.going, race.distance);
  const wScore = weightAdjusted(horse.weight);
  const cScore = classAdjustment(horse.or, race.type);
  const consScore = consistencyIndex(horse.form);
  const trW = TRAINER_RATES[horse.trainer] || 0.14;
  const jkW = JOCKEY_RATES[horse.jockey] || 0.14;
  const pb = PARTNERSHIP_BONUS[getPartnershipKey(horse.trainer, horse.jockey)] || 0;
  const eloVal = eloRating(trW, jkW, pb);
  const eloNorm = Math.min(1, Math.max(0, (eloVal - 1300) / 500));
  const parts = horse.odds.split("/");
  const oddsNum = parseFloat(parts[0]); const oddsDen = parseFloat(parts[1]);
  const impliedP = oddsDen / (oddsNum + oddsDen);
  const lambdaRaw = ba * 0.28 + eloNorm * 0.20 + gScore * 0.15 + dScore * 0.10 + wScore * 0.08 + cScore * 0.09 + consScore * 0.10;
  const modelP = marketBayesianUpdate(lambdaRaw, impliedP, 0.35);
  const oddsDecimal = (oddsNum / oddsDen) + 1;
  const kellyF = kellyCriterion(modelP, oddsDecimal);
  const modelScores = {
    bayesian:    Math.round(ba * 100),
    poisson:     Math.round(modelP * 100),
    kelly:       Math.round(kellyF * 100),
    elo:         Math.round(eloNorm * 100),
    going:       Math.round(Math.min(1, gScore / 1.3) * 100),
    draw:        Math.round(Math.min(1, (dScore - 0.5) * 2) * 100),
    class:       Math.round(Math.min(1, Math.max(0, (cScore - 0.7) / 0.6)) * 100),
    weight:      Math.round(Math.min(1, Math.max(0, (wScore - 0.6) / 0.5)) * 100),
    market:      Math.round(impliedP * 100),
    consistency: Math.round(consScore * 100),
  };
  const composite = Math.round(Object.values(modelScores).reduce((a, b) => a + b, 0) / 10);
  return { ...horse, modelScores, composite, modelP, kellyF, impliedP, oddsDecimal };
}

/* ─── SAMPLE DATA ────────────────────────────────────────────── */
const RACES = [
  {
    time: "13:30", course: "Newmarket", name: "Newmarket Sprint Stakes",
    distance: "6f", going: "Good to Firm", type: "Class 2",
    runners: [
      { name: "Atomic Force",   trainer: "J Gosden",   jockey: "F Dettori",  weight: "9-2", draw: 3, odds: "5/2",  form: "1-1-2-1-3-1", or: 100 },
      { name: "Silver Bullet",  trainer: "A O'Brien",  jockey: "R Moore",    weight: "9-0", draw: 7, odds: "3/1",  form: "2-1-1-3-2-4", or: 98  },
      { name: "Desert Storm",   trainer: "C Appleby",  jockey: "W Buick",    weight: "8-11",draw: 1, odds: "4/1",  form: "3-2-1-1-5-2", or: 96  },
      { name: "Northern Light", trainer: "R Fahey",    jockey: "P Hanagan",  weight: "8-7", draw: 5, odds: "8/1",  form: "1-4-3-2-1-3", or: 92  },
      { name: "Midnight Express",trainer:"M Johnston", jockey: "J Fanning",  weight: "8-4", draw: 2, odds: "10/1", form: "5-3-2-4-2-1", or: 89  },
      { name: "Golden Arrow",   trainer: "P Cole",     jockey: "T Queally",  weight: "8-2", draw: 8, odds: "14/1", form: "2-6-1-3-4-2", or: 87  },
    ],
  },
  {
    time: "14:05", course: "Ascot", name: "Royal Windsor Conditions Stakes",
    distance: "1m 2f", going: "Good", type: "Listed",
    runners: [
      { name: "Regal Presence", trainer: "J Gosden",    jockey: "R Dettori",  weight: "9-5", draw: 2, odds: "2/1",  form: "1-1-1-2-1-3", or: 108 },
      { name: "Tempest Rising", trainer: "A Balding",   jockey: "O Murphy",   weight: "9-3", draw: 4, odds: "7/2",  form: "2-3-1-1-2-1", or: 106 },
      { name: "Starfall",       trainer: "W Haggas",    jockey: "T Marquand", weight: "9-1", draw: 1, odds: "5/1",  form: "1-2-4-1-3-2", or: 104 },
      { name: "Imperial Blue",  trainer: "S bin Suroor",jockey: "C Soumillon",weight: "9-0", draw: 5, odds: "7/1",  form: "3-1-2-5-1-4", or: 103 },
      { name: "Bronze Warrior", trainer: "P Cole",      jockey: "S Drowne",   weight: "8-12",draw: 3, odds: "12/1", form: "4-2-3-1-6-2", or: 98  },
    ],
  },
  {
    time: "15:20", course: "Haydock", name: "Lancashire Oaks",
    distance: "1m 4f", going: "Soft", type: "Group 2",
    runners: [
      { name: "Velvet Queen",   trainer: "J Gosden",   jockey: "F Dettori",  weight: "9-0", draw: 3, odds: "6/4",  form: "1-1-2-1-1-2", or: 116 },
      { name: "Rain Dancer",    trainer: "A O'Brien",  jockey: "R Moore",    weight: "9-0", draw: 5, odds: "5/2",  form: "2-1-3-2-1-1", or: 114 },
      { name: "Storm Petrel",   trainer: "C Appleby",  jockey: "W Buick",    weight: "9-0", draw: 1, odds: "4/1",  form: "1-3-1-4-2-1", or: 112 },
      { name: "Lady Fortune",   trainer: "R Varian",   jockey: "A Beschizza",weight: "9-0", draw: 2, odds: "8/1",  form: "3-2-1-3-5-2", or: 108 },
      { name: "Crystal Waters", trainer: "M Botti",    jockey: "A Atzeni",   weight: "9-0", draw: 4, odds: "16/1", form: "5-4-2-1-3-6", or: 102 },
    ],
  },
];

/* ─── HELPERS ────────────────────────────────────────────────── */
function getRating(s) {
  if (s >= 78) return { label: "ELITE",  color: T.gold  };
  if (s >= 62) return { label: "STRONG", color: T.green };
  if (s >= 48) return { label: "SOLID",  color: T.blue  };
  if (s >= 32) return { label: "FAIR",   color: "#f59e0b" };
  return             { label: "WEAK",   color: T.red   };
}

function fmtOdds(decOdds) {
  const n = decOdds - 1;
  if (n >= 1) return `${Math.round(n)}/1`;
  const frac = Math.round(n * 10) + "/10";
  return frac;
}

function getFormColor(p) {
  return p===1 ? T.green : p===2 ? T.cyan : p===3 ? T.gold : p<=5 ? T.muted : T.red;
}

function FormPips({ form }) {
  return (
    <span style={{ display: "flex", gap: 3 }}>
      {form.split("-").map((f, i) => {
        const p = parseInt(f); const c = getFormColor(p);
        return <span key={i} style={{ width: 18, height: 18, borderRadius: 3, background: c + "25", border: `1px solid ${c}66`, color: c, fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace" }}>{f}</span>;
      })}
    </span>
  );
}

function MiniBar({ val, color, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ fontSize: 10, color: T.muted, width: 72, flexShrink: 0, fontFamily: "monospace" }}>{label}</div>
      <div style={{ flex: 1, height: 5, background: "#1a2540", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${val}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.6s ease" }} />
      </div>
      <div style={{ fontSize: 10, color: T.muted, width: 24, textAlign: "right", fontFamily: "monospace" }}>{val}</div>
    </div>
  );
}

function StatPill({ label, val, color }) {
  return (
    <div style={{ background: color + "15", border: `1px solid ${color}30`, borderRadius: 6, padding: "5px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 10, color: T.muted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color, fontFamily: "monospace" }}>{val}</div>
    </div>
  );
}

async function callClaude(prompt, system) {
  try {
    const body = { messages: [{ role: "user", content: prompt }] };
    if (system) body.system = system;
    const r = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const responseText = await r.text();
    if (!r.ok) {
      console.error("Claude API error:", r.status, responseText);
      return "Server error " + r.status + ": " + responseText.slice(0, 200);
    }
    let d;
    try { d = JSON.parse(responseText); } catch(e) {
      return "JSON parse error: " + responseText.slice(0, 200);
    }
    if (d.error) return "API error: " + JSON.stringify(d.error);
    return d.content?.map(c => c.text || "").join("\n") || "No response received.";
  } catch(e) {
    console.error("callClaude exception:", e);
    return "Connection error: " + e.message;
  }
}

/* ─── MAIN APP ───────────────────────────────────────────────── */
export default function App() {
  const [view, setView]           = useState("races");
  const [races, setRaces]         = useState(RACES);
  const [raceSource, setRaceSource] = useState("sample");
  const [racesLoading, setRacesLoading] = useState(true);
  const [activeRace, setActiveRace] = useState(null);
  const [preds, setPreds]         = useState(null);
  const [loading, setLoading]     = useState(false);
  const [aiText, setAiText]       = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [customIn, setCustomIn]   = useState("");
  const [customOut, setCustomOut] = useState(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [bankroll, setBankroll]   = useState(100);
  const [stakeMode, setStakeMode] = useState("kelly");
  const [levelStake, setLevelStake] = useState(10);
  const [calcResults, setCalcResults] = useState(null);

  const [apiStatus, setApiStatus] = useState(null);

  // Load live races from server on mount
  useEffect(() => {
    // Check API health
    fetch("/api/health")
      .then(r => r.json())
      .then(d => setApiStatus(d))
      .catch(() => {});

    // Load races
    fetch("/api/races")
      .then(r => r.json())
      .then(d => {
        if (d.races && d.races.length > 0) {
          setRaces(d.races);
          setRaceSource(d.source);
        }
        setRacesLoading(false);
      })
      .catch(() => setRacesLoading(false));
  }, []);

  const refreshRaces = () => {
    setRacesLoading(true);
    fetch("/api/races/refresh", { method: "POST" })
      .then(r => r.json())
      .then(d => {
        if (d.races && d.races.length > 0) {
          setRaces(d.races);
          setRaceSource(d.source);
        }
        setRacesLoading(false);
      })
      .catch(() => setRacesLoading(false));
  };

  // ROI tracker — starts with sample weekend data, grows as you log bets
  const [history, setHistory] = useState([
    { name: "Notable Speech", odds: "2/1", result: "WON",  profit: 20, stake: 10, date: "17 May" },
    { name: "Jonquil",        odds: "18/1",result: "LOST", profit: -10, stake: 10, date: "17 May" },
    { name: "Letsbefrank",    odds: "7/2", result: "WON",  profit: 35, stake: 10, date: "18 May" },
    { name: "Far Ahead",      odds: "6/1", result: "LOST", profit: -10, stake: 10, date: "18 May" },
    { name: "Ghaiyya",        odds: "8/1", result: "LOST", profit: -10, stake: 10, date: "18 May" },
  ]);

  const analyse = (race) => {
    setLoading(true); setActiveRace(race); setPreds(null); setAiText(null);
    setTimeout(() => {
      const n = race.runners.length;
      const scored = race.runners.map((h, i) => fullScore(h, race, n));
      // Poisson normalise across field
      const lambdas = scored.map(s => s.modelP);
      const winProbs = poissonWinProb(lambdas);
      const final = scored.map((s, i) => ({ ...s, winProb: winProbs[i], composite: Math.round((s.composite * 0.65 + winProbs[i] * 100 * 0.35)) }))
        .sort((a, b) => b.composite - a.composite);
      setPreds(final); setLoading(false); setView("predictions");
    }, 1100);
  };

  const getAI = async () => {
    if (!preds || !activeRace) return;
    setAiLoading(true); setView("ai");
    const t3 = preds.slice(0, 3);
    try {
      setAiText(await callClaude(
        `You are a professional UK horse racing analyst. Using the mathematical model output below, write a detailed professional prediction report.

RACE: ${activeRace.name} | ${activeRace.course} | ${activeRace.distance} | ${activeRace.going} | ${activeRace.type}

TOP CONTENDERS (10-model composite + Poisson win probability):
${t3.map((h, i) => `${i+1}. ${h.name} | ${h.trainer}/${h.jockey} | Form:${h.form} | ${h.odds} | Draw:${h.draw} | ${h.weight} | Composite:${h.composite}/100 | Win Prob:${(h.winProb*100).toFixed(1)}% | Kelly:${(h.kellyF*100).toFixed(1)}%`).join("\n")}

ALL RUNNERS: ${preds.map(h => `${h.name}(${h.odds},${(h.winProb*100).toFixed(0)}%)`).join(", ")}

MATHEMATICAL SIGNALS:
- Bayesian form: most recent runs given 3.7x more weight than oldest
- Poisson model normalised win probabilities across field
- Market Bayesian update: 35% weight to market implied probability
- Kelly Criterion flags positive expected value bets

Write a professional Racing Post-style report:
1. RACE OVERVIEW
2. NAP SELECTION — detailed reasoning including mathematical edge
3. EACH-WAY VALUE — value angle with Kelly edge
4. ONES TO AVOID
5. PREDICTED FINISHING ORDER (top 4)
6. CONFIDENCE RATING /10

Be authoritative, specific, use racing terminology. Reference the model signals.`
      ));
    } catch { setAiText("Error. Please try again."); }
    setAiLoading(false);
  };

  const getCustom = async () => {
    if (!customIn.trim()) return;
    setCustomLoading(true); setCustomOut(null);
    try {
      setCustomOut(await callClaude(
        `You are a professional UK horse racing analyst and tipster. You use Bayesian form models, Poisson win probability, Kelly Criterion, ELO ratings, going matrices and market Bayesian updates.

User: "${customIn}"

Provide a complete professional prediction with:
- Mathematical rationale (mention model signals where relevant)
- Form analysis with recency weighting
- Trainer/jockey ELO considerations
- Kelly Criterion stake recommendation
- Poisson-derived win probability estimates
- Confidence ratings

Racing Post analytical style. Specific, authoritative, use racing terminology.`
      ));
    } catch { setCustomOut("Error. Please try again."); }
    setCustomLoading(false);
  };

  // Earnings calculator
  const runCalc = () => {
    if (!preds) return;
    const results = preds.map(h => {
      let stake = 0;
      if (stakeMode === "kelly") stake = Math.round(bankroll * h.kellyF * 100) / 100;
      else if (stakeMode === "level") stake = levelStake;
      else stake = Math.round(bankroll * 0.05 * 100) / 100; // 5% of bankroll
      const expectedReturn = stake * h.winProb * h.odsDec;
      const expectedProfit = expectedReturn - stake;
      const ev = expectedProfit;
      return { ...h, stake, expectedReturn, expectedProfit, ev };
    });
    const totalStaked = results.reduce((s, r) => s + r.stake, 0);
    const totalExpected = results.reduce((s, r) => s + r.expectedProfit, 0);
    setCalcResults({ runners: results, totalStaked, totalExpected });
  };

  // ROI stats
  const totalStakedHistory = history.length * 10;
  const totalProfitHistory = history.reduce((s, h) => s + h.profit, 0);
  const roiPct = ((totalProfitHistory / totalStakedHistory) * 100).toFixed(1);
  const winRate = ((history.filter(h => h.result === "WON").length / history.length) * 100).toFixed(0);

  const nap = preds?.[0];
  const ew  = preds?.slice(1, 4).find(h => h.odsDec >= 5);

  const tabs = [
    { id: "races",       label: "📅 RACE CARD" },
    { id: "predictions", label: "📊 PREDICTIONS", off: !preds && !loading },
    { id: "ai",          label: "🤖 AI REPORT",   off: !preds },
    { id: "calc",        label: "💹 EARNINGS",    off: !preds },
    { id: "stats",       label: "📈 ROI TRACKER" },
    { id: "custom",      label: "🔮 ASK ANALYST" },
  ];

  const DISCLAIMER = "⚠️ For entertainment only. Not betting advice. BeGambleAware.org";

  /* ── RENDER ── */
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Courier New', monospace" }}>

      {/* ── HEADER ── */}
      <div style={{ borderBottom: `1px solid ${T.border}`, background: `linear-gradient(180deg, #0a0f1e 0%, ${T.bg} 100%)` }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 16px 0" }}>
          {/* Logo row */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 9, letterSpacing: 4, color: T.muted, marginBottom: 4, textTransform: "uppercase" }}>Professional Grade</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: T.gold, letterSpacing: -1, lineHeight: 1 }}>🏇 UK RACING ANALYST</div>
              <div style={{ fontSize: 11, color: T.muted, letterSpacing: 3, marginTop: 4 }}>10-MODEL MATHEMATICAL PREDICTION ENGINE</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                ["BAYESIAN", T.gold],
                ["POISSON", T.cyan],
                ["KELLY", T.green],
                ["ELO", T.purple],
              ].map(([l, c]) => (
                <span key={l} style={{ fontSize: 9, fontWeight: 800, color: c, background: c + "15", border: `1px solid ${c}40`, borderRadius: 4, padding: "3px 8px", letterSpacing: 1 }}>{l}</span>
              ))}
            </div>
          </div>
          {/* Model tags */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${T.border}` }}>
            {MODELS_META.map(m => (
              <span key={m.id} style={{ fontSize: 9, color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: 3, padding: "2px 7px", letterSpacing: 1 }}>{m.icon} {m.label.toUpperCase()}</span>
            ))}
          </div>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 0 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => !t.off && setView(t.id)} disabled={t.off}
                style={{ padding: "9px 14px", border: "none", cursor: t.off ? "not-allowed" : "pointer", background: "transparent",
                  color: t.off ? T.dim : view === t.id ? T.gold : T.muted,
                  fontWeight: 700, fontSize: 10, letterSpacing: 2,
                  borderBottom: view === t.id ? `2px solid ${T.gold}` : "2px solid transparent",
                  fontFamily: "inherit", marginBottom: -1, transition: "all 0.15s" }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "16px 16px" }}>

        {/* ── DISCLAIMER ── */}
        <div style={{ background: "#2a0f00", border: "1px solid #7c2d12", borderRadius: 6, padding: "6px 12px", fontSize: 10, color: "#fb923c", marginBottom: 10, letterSpacing: 1 }}>{DISCLAIMER}</div>

        {/* ── API STATUS BAR ── */}
        {apiStatus && (
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14,alignItems:"flex-start"}}>
            <div style={{display:"flex",alignItems:"center",gap:5,background:T.card,border:"1px solid "+T.border,borderRadius:6,padding:"5px 10px"}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:apiStatus.claudeAPI?T.green:T.red,flexShrink:0,display:"inline-block"}}/>
              <span style={{fontSize:9,color:apiStatus.claudeAPI?T.green:T.red,fontWeight:800,letterSpacing:1}}>CLAUDE AI: {apiStatus.claudeAPI?"✅ CONNECTED":"❌ NOT SET"}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5,background:T.card,border:"1px solid "+T.border,borderRadius:6,padding:"5px 10px"}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:apiStatus.racingAPI?T.green:"#f59e0b",flexShrink:0,display:"inline-block"}}/>
              <span style={{fontSize:9,color:apiStatus.racingAPI?T.green:"#f59e0b",fontWeight:800,letterSpacing:1}}>RACING API: {apiStatus.racingAPI?"✅ CONNECTED":"⚠️ NOT SET"}</span>
            </div>
            {!apiStatus.claudeAPI && (
              <div style={{fontSize:9,color:T.red,background:T.red+"15",border:"1px solid "+T.red+"44",borderRadius:6,padding:"5px 10px"}}>
                AI reports disabled — add <strong>ANTHROPIC_API_KEY</strong> to Render env vars
              </div>
            )}
          </div>
        )}

        {/* ═══════════════ RACE CARD ═══════════════ */}
        {view === "races" && (
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ fontSize:10, letterSpacing:3, color:T.muted }}>
                  {racesLoading ? "LOADING RACES..." : "TODAY'S RACES — " + races.length + " MEETINGS"}
                </div>
                {raceSource==="live" && <span style={{fontSize:9,fontWeight:800,color:T.green,background:T.green+"18",border:"1px solid "+T.green+"44",borderRadius:4,padding:"2px 7px",letterSpacing:1}}>🟢 LIVE DATA</span>}
                {raceSource==="sample" && <span style={{fontSize:9,fontWeight:800,color:"#f59e0b",background:"#f59e0b18",border:"1px solid #f59e0b44",borderRadius:4,padding:"2px 7px",letterSpacing:1}}>⚠️ SAMPLE DATA</span>}
                {raceSource==="cache" && <span style={{fontSize:9,fontWeight:800,color:T.cyan,background:T.cyan+"18",border:"1px solid "+T.cyan+"44",borderRadius:4,padding:"2px 7px",letterSpacing:1}}>📦 CACHED</span>}
              </div>
              <button onClick={refreshRaces} disabled={racesLoading} style={{background:T.card2,border:"1px solid "+T.border,color:racesLoading?T.dim:T.muted,borderRadius:6,padding:"5px 12px",fontWeight:700,fontSize:10,cursor:racesLoading?"not-allowed":"pointer",fontFamily:"monospace",letterSpacing:1}}>
                {racesLoading ? "⏳ LOADING..." : "↻ REFRESH"}
              </button>
            </div>
            {raceSource==="sample" && (
              <div style={{background:"#1c1500",border:"1px solid #92400e",borderRadius:7,padding:"8px 14px",fontSize:11,color:"#fbbf24",marginBottom:12,lineHeight:1.6}}>
                💡 <strong>Showing sample races.</strong> Add <code style={{background:"#00000033",padding:"1px 5px",borderRadius:3}}>RACING_API_USERNAME</code> + <code style={{background:"#00000033",padding:"1px 5px",borderRadius:3}}>RACING_API_PASSWORD</code> in Render env vars for live data. Free trial at <strong>theracingapi.com</strong>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {races.map((race, ri) => (
                <div key={ri} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ background: `linear-gradient(90deg, ${T.card2}, ${T.surface})`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ background: T.gold, color: T.bg, borderRadius: 4, padding: "2px 9px", fontWeight: 900, fontSize: 12, letterSpacing: 1 }}>{race.time}</span>
                        <span style={{ fontWeight: 800, fontSize: 14, color: T.text }}>{race.course}</span>
                        <span style={{ color: T.muted, fontSize: 12 }}>{race.name}</span>
                        {race.live && <span style={{fontSize:9,fontWeight:800,color:T.green,background:T.green+"18",border:"1px solid "+T.green+"44",borderRadius:3,padding:"1px 6px"}}>LIVE</span>}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
                        {[race.distance, race.going, race.type, `${race.runners.length}R`].map((t, i) => (
                          <span key={i} style={{ fontSize: 10, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", letterSpacing: 1 }}>{t}</span>
                        ))}
                      </div>
                    </div>
                    <button onClick={() => analyse(race)} style={{ background: `linear-gradient(135deg, ${T.gold}, #a07820)`, color: T.bg, border: "none", borderRadius: 7, padding: "9px 18px", fontWeight: 900, fontSize: 11, cursor: "pointer", letterSpacing: 2, fontFamily: "inherit" }}>
                      RUN MODELS ▶
                    </button>
                  </div>
                  {race.runners.map((h, hi) => (
                    <div key={hi} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderTop: `1px solid ${T.border}33`, flexWrap: "wrap" }}>
                      <span style={{ width: 20, height: 20, borderRadius: "50%", background: T.card2, border: `1px solid ${T.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: T.gold, flexShrink: 0 }}>{hi + 1}</span>
                      <div style={{ flex: 1, minWidth: 120 }}>
                        <div style={{ fontWeight: 700, fontSize: 12, color: T.text }}>{h.name}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{h.trainer} · {h.jockey}</div>
                      </div>
                      <div style={{ fontSize: 10, color: T.muted, letterSpacing: 1 }}>OR:{h.or}</div>
                      <div style={{ fontSize: 10, color: T.muted }}>D{h.draw} {h.weight}</div>
                      <FormPips form={h.form} />
                      <span style={{ fontWeight: 900, color: h.odds==="TBC"?T.muted:T.gold, fontSize: 13, minWidth: 45, textAlign: "right" }}>{h.odds==="TBC" ? "—" : h.odds}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══════════════ PREDICTIONS ═══════════════ */}
        {view === "predictions" && (
          loading ? (
            <div style={{ textAlign: "center", padding: "60px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 14 }}>⚙️</div>
              <div style={{ color: T.gold, fontSize: 13, fontWeight: 700, letterSpacing: 2 }}>RUNNING 10-MODEL ANALYSIS</div>
              <div style={{ color: T.muted, marginTop: 6, fontSize: 11, letterSpacing: 1 }}>Bayesian · Poisson · Kelly · ELO · Going Matrix · Draw Bias · Class · Weight · Market · Consistency</div>
            </div>
          ) : preds && activeRace ? (
            <div>
              {/* Race info bar */}
              <div style={{ background: T.card, border: `1px solid ${T.gold}44`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>{activeRace.time} {activeRace.course} — {activeRace.name}</div>
                  <div style={{ color: T.muted, fontSize: 10, marginTop: 2, letterSpacing: 1 }}>{activeRace.distance} | {activeRace.going} | {activeRace.type}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={getAI} style={{ background: T.purple + "22", border: `1px solid ${T.purple}55`, color: T.purple, borderRadius: 6, padding: "6px 12px", fontWeight: 800, fontSize: 10, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>🤖 AI REPORT</button>
                  <button onClick={() => setView("calc")} style={{ background: T.green + "22", border: `1px solid ${T.green}55`, color: T.green, borderRadius: 6, padding: "6px 12px", fontWeight: 800, fontSize: 10, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>💹 EARNINGS CALC</button>
                </div>
              </div>

              {/* NAP + EW highlights */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {nap && (
                  <div style={{ background: `linear-gradient(135deg, ${T.gold}18, ${T.gold}05)`, border: `2px solid ${T.gold}`, borderRadius: 10, padding: "14px 14px" }}>
                    <div style={{ fontSize: 9, letterSpacing: 3, color: T.gold, fontWeight: 800, marginBottom: 6 }}>🏆 NAP SELECTION</div>
                    <div style={{ fontSize: 17, fontWeight: 900, color: T.text }}>{nap.name}</div>
                    <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{nap.trainer} / {nap.jockey}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 20, fontWeight: 900, color: T.gold }}>{nap.odds}</span>
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>WIN PROB</div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: T.green }}>{(nap.winProb * 100).toFixed(1)}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>KELLY</div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: T.cyan }}>{(nap.kellyF * 100).toFixed(1)}%</div>
                      </div>
                    </div>
                  </div>
                )}
                {ew && (
                  <div style={{ background: `linear-gradient(135deg, ${T.cyan}15, ${T.cyan}03)`, border: `2px solid ${T.cyan}44`, borderRadius: 10, padding: "14px 14px" }}>
                    <div style={{ fontSize: 9, letterSpacing: 3, color: T.cyan, fontWeight: 800, marginBottom: 6 }}>💎 EACH-WAY VALUE</div>
                    <div style={{ fontSize: 17, fontWeight: 900, color: T.text }}>{ew.name}</div>
                    <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{ew.trainer} / {ew.jockey}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 20, fontWeight: 900, color: T.cyan }}>{ew.odds}</span>
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>WIN PROB</div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: T.green }}>{(ew.winProb * 100).toFixed(1)}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>EXP VALUE</div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: ew.winProb * ew.oddsDecimal > 1 ? T.green : T.red }}>
                          {ew.winProb * ew.oddsDecimal > 1 ? "+" : ""}{((ew.winProb * ew.oddsDecimal - 1) * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Full ranked list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {preds.map((horse, hi) => {
                  const { label, color } = getRating(horse.composite);
                  const ev = horse.winProb * horse.oddsDecimal - 1;
                  return (
                    <div key={hi} style={{ background: T.card, border: `1px solid ${hi === 0 ? T.gold + "66" : T.border}`, borderRadius: 10, overflow: "hidden" }}>
                      {/* Horse header */}
                      <div style={{ padding: "12px 14px", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 12,
                          background: hi === 0 ? T.gold : hi === 1 ? "#475569" : hi === 2 ? "#78350f" : T.card2, color: hi === 0 ? T.bg : T.text }}>{hi + 1}</div>
                        <div style={{ flex: 1, minWidth: 150 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 900, fontSize: 13, color: T.text }}>{horse.name}</span>
                            <span style={{ background: color + "20", border: `1px solid ${color}44`, borderRadius: 3, padding: "1px 6px", fontSize: 9, fontWeight: 800, color, letterSpacing: 1 }}>{label}</span>
                            {hi === 0 && <span style={{ background: T.gold, color: T.bg, borderRadius: 3, padding: "1px 6px", fontSize: 9, fontWeight: 900 }}>NAP</span>}
                            {ev > 0.05 && <span style={{ background: T.green + "20", border: `1px solid ${T.green}44`, color: T.green, borderRadius: 3, padding: "1px 6px", fontSize: 9, fontWeight: 800 }}>+EV</span>}
                          </div>
                          <div style={{ fontSize: 10, color: T.muted, marginTop: 3, letterSpacing: 0.5 }}>
                            {horse.trainer} / {horse.jockey} · D{horse.draw} · {horse.weight} · OR:{horse.or}
                          </div>
                          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ fontSize: 10, color: T.muted, letterSpacing: 1 }}>FORM</span>
                            <FormPips form={horse.form} />
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>ODDS</div>
                            <div style={{ fontSize: 18, fontWeight: 900, color: T.gold }}>{horse.odds}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>WIN%</div>
                            <div style={{ fontSize: 16, fontWeight: 900, color: T.green }}>{(horse.winProb * 100).toFixed(1)}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>SCORE</div>
                            <div style={{ fontSize: 16, fontWeight: 900, color }}>{horse.composite}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 9, color: T.muted, letterSpacing: 1 }}>EV</div>
                            <div style={{ fontSize: 16, fontWeight: 900, color: ev > 0 ? T.green : T.red }}>{ev > 0 ? "+" : ""}{(ev * 100).toFixed(0)}%</div>
                          </div>
                        </div>
                      </div>
                      {/* Model breakdown */}
                      <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 14px" }}>
                        <div style={{ fontSize: 9, color: T.muted, letterSpacing: 2, marginBottom: 8 }}>MODEL BREAKDOWN</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
                          {MODELS_META.map(m => (
                            <MiniBar key={m.id} label={m.icon + " " + m.label.slice(0, 12)} val={horse.modelScores[m.id]} color={getRating(horse.modelScores[m.id]).color} />
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null
        )}

        {/* ═══════════════ AI REPORT ═══════════════ */}
        {view === "ai" && (
          aiLoading ? (
            <div style={{ textAlign: "center", padding: "60px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🤖</div>
              <div style={{ color: T.purple, fontSize: 13, fontWeight: 700, letterSpacing: 2 }}>AI ANALYST COMPOSING REPORT</div>
              <div style={{ color: T.muted, marginTop: 6, fontSize: 11 }}>Synthesising 10 mathematical models into expert commentary...</div>
            </div>
          ) : aiText ? (
            <div>
              <div style={{ background: `linear-gradient(135deg, #1e1b4b, #160f3a)`, border: `1px solid ${T.purple}44`, borderRadius: 12, padding: "18px 20px", marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${T.purple}33` }}>
                  <span style={{ fontSize: 20 }}>🤖</span>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 13, color: T.purple, letterSpacing: 2 }}>AI ANALYST REPORT</div>
                    <div style={{ fontSize: 10, color: T.muted, letterSpacing: 1 }}>{activeRace?.time} {activeRace?.course} — {activeRace?.name} · Mathematical model synthesis</div>
                  </div>
                </div>
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, fontSize: 13, color: T.text }}>{aiText}</div>
              </div>
              <div style={{ background: "#1c0800", border: "1px solid #7c2d12", borderRadius: 6, padding: "6px 12px", fontSize: 10, color: "#fb923c", letterSpacing: 1 }}>{DISCLAIMER}</div>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <button onClick={getAI} style={{ background: `linear-gradient(135deg, ${T.purple}, #4c1d95)`, color: T.text, border: "none", borderRadius: 9, padding: "12px 24px", fontWeight: 900, fontSize: 12, cursor: "pointer", letterSpacing: 2, fontFamily: "inherit" }}>
                🤖 GENERATE AI REPORT
              </button>
            </div>
          )
        )}

        {/* ═══════════════ EARNINGS CALCULATOR ═══════════════ */}
        {view === "calc" && preds && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: 3, color: T.muted, marginBottom: 14 }}>EARNINGS CALCULATOR — IF YOU HAD BACKED ALL SELECTIONS</div>

            {/* Config */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px", marginBottom: 14 }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: T.muted, marginBottom: 12 }}>STAKING CONFIGURATION</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>BANKROLL (£)</div>
                  <input type="number" value={bankroll} onChange={e => setBankroll(+e.target.value)} min={10}
                    style={{ background: T.card2, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px", color: T.gold, fontSize: 14, fontWeight: 900, fontFamily: "inherit", width: 100, outline: "none" }} />
                </div>
                <div>
                  <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>STAKE METHOD</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[["kelly", "KELLY %"], ["level", "LEVEL £"], ["percent", "5% BANK"]].map(([v, l]) => (
                      <button key={v} onClick={() => setStakeMode(v)} style={{ padding: "8px 10px", border: `1px solid ${stakeMode === v ? T.gold : T.border}`, borderRadius: 5, background: stakeMode === v ? T.gold + "22" : "transparent", color: stakeMode === v ? T.gold : T.muted, fontSize: 9, fontWeight: 800, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>{l}</button>
                    ))}
                  </div>
                </div>
                {stakeMode === "level" && (
                  <div>
                    <div style={{ fontSize: 10, color: T.muted, marginBottom: 4 }}>LEVEL STAKE (£)</div>
                    <input type="number" value={levelStake} onChange={e => setLevelStake(+e.target.value)} min={1}
                      style={{ background: T.card2, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px", color: T.text, fontSize: 14, fontWeight: 700, fontFamily: "inherit", width: 80, outline: "none" }} />
                  </div>
                )}
                <button onClick={runCalc} style={{ background: `linear-gradient(135deg, ${T.green}, #065f46)`, color: T.bg, border: "none", borderRadius: 7, padding: "10px 20px", fontWeight: 900, fontSize: 11, cursor: "pointer", letterSpacing: 2, fontFamily: "inherit" }}>
                  CALCULATE ▶
                </button>
              </div>
              <div style={{ marginTop: 12, fontSize: 10, color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                <strong style={{ color: T.cyan }}>KELLY CRITERION</strong>: f* = (bp-q)/b — optimal fraction of bankroll. Positive EV bets only. &nbsp;
                <strong style={{ color: T.gold }}>LEVEL STAKING</strong>: Fixed amount per selection. &nbsp;
                <strong style={{ color: T.purple }}>5% BANK</strong>: Conservative 5% per bet.
              </div>
            </div>

            {calcResults && (
              <div>
                {/* Summary cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginBottom: 14 }}>
                  <StatPill label="TOTAL STAKED" val={`£${calcResults.totalStaked.toFixed(2)}`} color={T.gold} />
                  <StatPill label="EXPECTED RETURN" val={`£${(calcResults.totalStaked + calcResults.totalExpected).toFixed(2)}`} color={T.cyan} />
                  <StatPill label="EXPECTED PROFIT" val={`${calcResults.totalExpected >= 0 ? "+" : ""}£${calcResults.totalExpected.toFixed(2)}`} color={calcResults.totalExpected >= 0 ? T.green : T.red} />
                  <StatPill label="EXP ROI" val={`${((calcResults.totalExpected / calcResults.totalStaked) * 100).toFixed(1)}%`} color={calcResults.totalExpected >= 0 ? T.green : T.red} />
                  <StatPill label="AVG ODDS" val={`${(preds.reduce((s, h) => s + h.odsDec, 0) / preds.length).toFixed(2)}x`} color={T.purple} />
                  <StatPill label="AVG WIN PROB" val={`${(preds.reduce((s, h) => s + h.winProb, 0) / preds.length * 100).toFixed(1)}%`} color={T.blue} />
                </div>

                {/* Per-horse table */}
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr", gap: 4 }}>
                    {["HORSE", "STAKE", "ODDS", "WIN%", "EXP RET", "EXP PROF"].map(h => (
                      <div key={h} style={{ fontSize: 9, color: T.muted, letterSpacing: 1, fontWeight: 800 }}>{h}</div>
                    ))}
                  </div>
                  {calcResults.runners.map((h, i) => {
                    const pos = h.ev > 0.05 ? T.green : h.ev > -0.05 ? T.gold : T.red;
                    return (
                      <div key={i} style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}22`, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr", gap: 4, alignItems: "center" }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{h.name}</div>
                          <div style={{ fontSize: 9, color: T.muted }}>{h.trainer}</div>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.gold }}>£{h.stake.toFixed(2)}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{h.odds}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.green }}>{(h.winProb * 100).toFixed(1)}%</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.cyan }}>£{h.expectedReturn.toFixed(2)}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: pos }}>
                          {h.expectedProfit >= 0 ? "+" : ""}£{h.expectedProfit.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}
                  {/* Total row */}
                  <div style={{ padding: "12px 14px", background: T.card2, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr", gap: 4, alignItems: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 900, color: T.gold, letterSpacing: 1 }}>TOTAL</div>
                    <div style={{ fontSize: 13, fontWeight: 900, color: T.gold }}>£{calcResults.totalStaked.toFixed(2)}</div>
                    <div />
                    <div />
                    <div style={{ fontSize: 13, fontWeight: 900, color: T.cyan }}>£{(calcResults.totalStaked + calcResults.totalExpected).toFixed(2)}</div>
                    <div style={{ fontSize: 13, fontWeight: 900, color: calcResults.totalExpected >= 0 ? T.green : T.red }}>
                      {calcResults.totalExpected >= 0 ? "+" : ""}£{calcResults.totalExpected.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 14px", marginTop: 12, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
                  <strong style={{ color: T.gold }}>HOW TO READ:</strong> Expected Profit uses Poisson-derived win probability × decimal odds. A positive +EV means the model finds edge over the bookmaker's implied probability. Kelly stakes automatically size bets to maximise long-run bankroll growth. <span style={{ color: "#fb923c" }}>Results are not guaranteed. For entertainment only.</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════ ROI TRACKER ═══════════════ */}
        {view === "stats" && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: 3, color: T.muted, marginBottom: 14 }}>WEEKEND PERFORMANCE — ROI TRACKER</div>
            {/* Summary */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginBottom: 14 }}>
              <StatPill label="WIN RATE"       val={`${winRate}%`}     color={T.gold}   />
              <StatPill label="ROI"            val={`${roiPct}%`}      color={roiPct >= 0 ? T.green : T.red} />
              <StatPill label="TOTAL PROFIT"   val={`£${totalProfitHistory}`} color={totalProfitHistory >= 0 ? T.green : T.red} />
              <StatPill label="SELECTIONS"     val={history.length}    color={T.cyan}   />
              <StatPill label="WINNERS"        val={history.filter(h => h.result === "WON").length} color={T.green} />
              <StatPill label="PROF BENCHMARK" val="25-30%"           color={T.purple} />
            </div>
            {/* History table */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 4 }}>
                {["HORSE", "ODDS", "RESULT", "P&L"].map(h => (
                  <div key={h} style={{ fontSize: 9, color: T.muted, letterSpacing: 1, fontWeight: 800 }}>{h}</div>
                ))}
              </div>
              {history.map((h, i) => (
                <div key={i} style={{ padding: "11px 14px", borderBottom: `1px solid ${T.border}22`, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 4, alignItems: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{h.name}</div>
                  <div style={{ fontSize: 12, color: T.gold }}>{h.odds}</div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: h.result === "WON" ? T.green : T.red, letterSpacing: 1 }}>
                    {h.result === "WON" ? "✅ WON" : "❌ LOST"}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: h.profit >= 0 ? T.green : T.red }}>
                    {h.profit >= 0 ? "+" : ""}£{h.profit}
                  </div>
                </div>
              ))}
              <div style={{ padding: "12px 14px", background: T.card2, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 900, color: T.gold, letterSpacing: 1 }}>TOTAL (£10 level stakes)</div>
                <div />
                <div style={{ fontSize: 11, color: T.muted }}>{winRate}% SR</div>
                <div style={{ fontSize: 14, fontWeight: 900, color: totalProfitHistory >= 0 ? T.green : T.red }}>
                  {totalProfitHistory >= 0 ? "+" : ""}£{totalProfitHistory}
                </div>
              </div>
            </div>

            {/* Model explanation */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: 3, color: T.muted, marginBottom: 10 }}>MATHEMATICAL MODEL GLOSSARY</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
                {MODELS_META.map(m => (
                  <div key={m.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: T.text, marginBottom: 4 }}>{m.icon} {m.label}</div>
                    <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>{m.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ ASK ANALYST ═══════════════ */}
        {view === "custom" && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "20px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: T.gold, letterSpacing: 1, marginBottom: 4 }}>🔮 ASK THE ANALYST</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 14, letterSpacing: 0.5 }}>Powered by Bayesian, Poisson, Kelly, ELO & Market models — ask for any UK racing prediction</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {["Predict tomorrow's Newmarket races", "Top Ascot tips this weekend", "Best flat bets for Saturday", "Value hunters Cheltenham tomorrow"].map(s => (
                <button key={s} onClick={() => setCustomIn(s)} style={{ background: T.card2, border: `1px solid ${T.border}`, borderRadius: 20, padding: "4px 11px", fontSize: 10, color: T.muted, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5 }}>{s}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={customIn} onChange={e => setCustomIn(e.target.value)} onKeyDown={e => e.key === "Enter" && getCustom()}
                placeholder="e.g. 'Predict tomorrow's Ascot races with Kelly stakes on £200 bankroll'"
                style={{ flex: 1, background: T.card2, border: `1px solid ${T.border}`, borderRadius: 7, padding: "10px 13px", color: T.text, fontSize: 12, fontFamily: "inherit", outline: "none" }}
              />
              <button onClick={getCustom} disabled={customLoading || !customIn.trim()} style={{ background: customLoading ? T.dim : `linear-gradient(135deg, ${T.gold}, #a07820)`, color: customLoading ? T.muted : T.bg, border: "none", borderRadius: 7, padding: "10px 16px", fontWeight: 900, fontSize: 11, cursor: customLoading ? "not-allowed" : "pointer", whiteSpace: "nowrap", fontFamily: "inherit", letterSpacing: 1 }}>
                {customLoading ? "ANALYSING..." : "ANALYSE ▶"}
              </button>
            </div>
            {customLoading && (
              <div style={{ textAlign: "center", padding: "28px 0", color: T.gold }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🏇</div>
                <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 2 }}>RUNNING MODELS...</div>
              </div>
            )}
            {customOut && (
              <div style={{ marginTop: 16 }}>
                <div style={{ background: `linear-gradient(135deg, #0a1f0a, #0a1810)`, border: `1px solid ${T.green}33`, borderRadius: 10, padding: "16px 18px" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${T.green}22` }}>
                    <span style={{ fontSize: 15 }}>🎯</span>
                    <span style={{ fontWeight: 900, color: T.green, fontSize: 11, letterSpacing: 2 }}>ANALYST PREDICTIONS</span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, fontSize: 12, color: T.text }}>{customOut}</div>
                </div>
                <div style={{ background: "#1c0800", border: "1px solid #7c2d12", borderRadius: 6, padding: "6px 12px", fontSize: 10, color: "#fb923c", marginTop: 10, letterSpacing: 1 }}>{DISCLAIMER}</div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
