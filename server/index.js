const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── RACE DATA CACHE ───────────────────────────────────────────────
let raceCache = { data: null, fetchedAt: null };
function cacheIsValid() {
  if (!raceCache.data || !raceCache.fetchedAt) return false;
  return (Date.now() - raceCache.fetchedAt) < 60 * 60 * 1000; // 1 hour
}

// ── RACING API TRANSFORM HELPERS ──────────────────────────────────
function formatTime(dt) {
  if (!dt) return "TBC";
  if (String(dt).includes("T")) return new Date(dt).toTimeString().slice(0,5);
  return String(dt).slice(0,5);
}
function formatWeight(lbs) {
  if (!lbs) return "9-0";
  return `${Math.floor(lbs/14)}-${lbs%14}`;
}
function formatOdds(odds) {
  if (!odds) return "10/1";
  const n = parseFloat(odds);
  if (isNaN(n) || n <= 1) return String(odds) || "10/1";
  const dec = n - 1;
  const fracs = [[1,5],[1,4],[1,3],[2,5],[1,2],[4,6],[4,5],[1,1],[6,5],[5,4],[7,5],[3,2],[7,4],[2,1],[9,4],[5,2],[3,1],[7,2],[4,1],[9,2],[5,1],[6,1],[7,1],[8,1],[10,1],[12,1],[14,1],[16,1],[20,1],[25,1],[33,1],[50,1]];
  let best = fracs[fracs.length-1], bestDiff = Infinity;
  for (const [num,den] of fracs) { const d=Math.abs(num/den-dec); if(d<bestDiff){bestDiff=d;best=[num,den];} }
  return `${best[0]}/${best[1]}`;
}
function formatForm(f) {
  if (!f) return "0-0-0";
  return String(f).replace(/[^0-9PFU]/gi,"").replace(/P/g,"9").replace(/F/g,"8").replace(/U/g,"7").replace(/(.)/g,"$1-").replace(/-$/,"").replace(/--+/g,"-") || "0-0-0";
}
function getRaceType(race) {
  const p = race.pattern || race.race_type || "";
  // actual field is race_class e.g. "Class 6"
  const rc = race.race_class || race.class || "";
  if (p.includes("Group 1") || rc.includes("Group 1")) return "Group 1";
  if (p.includes("Group 2") || rc.includes("Group 2")) return "Group 2";
  if (p.includes("Group 3") || rc.includes("Group 3")) return "Group 3";
  if (p.includes("Listed") || rc.includes("Listed")) return "Listed";
  if (rc.includes("Class")) return rc; // already formatted e.g. "Class 6"
  const c = String(race.class||"");
  const cn = parseInt(c);
  if (cn>=1&&cn<=6) return "Class " + cn;
  return race.type || "Flat";
}

// ── LIVE RACING API ───────────────────────────────────────────────
async function fetchFromRacingAPI() {
  const u = process.env.RACING_API_USERNAME;
  const p = process.env.RACING_API_PASSWORD;
  if (!u || !p) { console.log("No Racing API credentials — using sample data."); return null; }
  try {
    const today = new Date().toISOString().split("T")[0];
    const auth = Buffer.from(`${u}:${p}`).toString("base64");
    // Basic Plan endpoint — tries basic first, falls back to standard
    // Correct Basic Plan endpoint — no date param, region_codes is the filter
    const endpoints = [
      `https://api.theracingapi.com/v1/racecards/basic?region_codes=gb`,
      `https://api.theracingapi.com/v1/racecards/basic`,
      `https://api.theracingapi.com/v1/racecards?region_codes=gb`,
    ];
    let res = null;
    for (const url of endpoints) {
      console.log("Trying Racing API endpoint:", url);
      res = await fetch(url, { headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" } });
      console.log("  Status:", res.status);
      if (res.ok) break;
      if (res.status === 401) { console.error("Auth failed — check credentials"); return null; }
      if (res.status === 403) { console.log("Plan restriction on this endpoint, trying next..."); }
    }
    if (!res || !res.ok) { console.error("All endpoints failed, status:", res?.status); return null; }
    const bodyText = await res.text();
    if (!res.ok) {
      console.error("Racing API error:", res.status, bodyText.slice(0,300));
      return null;
    }
    let data;
    try { data = JSON.parse(bodyText); } catch(e) { console.error("Racing API JSON parse error:", e.message); return null; }
    console.log("Racing API response keys:", Object.keys(data));
    console.log("Racing API total races:", data.total || data.count || "unknown");
    // API returns { racecards: [...] }
    const racecards = data.racecards || data.races || data.data || data.results || [];
    console.log("Racecards found:", racecards.length);
    if (!racecards || !racecards.length) {
      console.error("No racecards in response. Keys:", Object.keys(data));
      return null;
    }
    const races = racecards
      .filter(r => r.runners && r.runners.length >= 2)
      .slice(0, 12)
      .map(r => ({
        id: r.race_id || ("r_" + Date.now() + "_" + Math.random()),
        time: formatTime(r.off_dt || r.off_time || r.off),
        course: r.course || r.venue || "Unknown",
        name: r.race_name || r.title || "Race",
        distance: r.distance_round || r.distance || r.dist || "1m",
        going: (r.going_detailed || r.going || "Good").split(",")[0].trim(),
        type: getRaceType(r),
        live: true,
        runners: (r.runners||[]).slice(0,20).map((h,i) => ({
          name: h.horse || h.name || ("Runner " + (i+1)),
          trainer: (typeof h.trainer === "object" ? h.trainer?.name : h.trainer) || "Unknown",
          jockey: (typeof h.jockey === "object" ? h.jockey?.name : h.jockey) || "Unknown",
          weight: formatWeight(h.lbs || h.weight_lbs || h.weight),
          draw: parseInt(h.draw) || i+1,
          odds: formatOdds(h.sp_dec || h.odds || h.current_odds || h.win_odds),
          form: formatForm(h.form || h.last_run_form || h.recent_form),
          or: parseInt(h.ofr || h.official_rating || h.or) || 90,
        }))
      }));
    return races.length > 0 ? races : null;
  } catch (err) {
    console.error("Racing API fetch failed:", err.message);
    return null;
  }
}

// ── SAMPLE DATA FALLBACK ──────────────────────────────────────────
const SAMPLE_RACES = [
  { id:"s1", time:"13:30", course:"Newmarket", name:"Newmarket Sprint Stakes", distance:"6f", going:"Good to Firm", type:"Class 2", live:false,
    runners:[
      {name:"Atomic Force",trainer:"J Gosden",jockey:"F Dettori",weight:"9-2",draw:3,odds:"5/2",form:"1-1-2-1-3-1",or:100},
      {name:"Silver Bullet",trainer:"A O'Brien",jockey:"R Moore",weight:"9-0",draw:7,odds:"3/1",form:"2-1-1-3-2-4",or:98},
      {name:"Desert Storm",trainer:"C Appleby",jockey:"W Buick",weight:"8-11",draw:1,odds:"4/1",form:"3-2-1-1-5-2",or:96},
      {name:"Northern Light",trainer:"R Fahey",jockey:"P Hanagan",weight:"8-7",draw:5,odds:"8/1",form:"1-4-3-2-1-3",or:92},
      {name:"Midnight Express",trainer:"M Johnston",jockey:"J Fanning",weight:"8-4",draw:2,odds:"10/1",form:"5-3-2-4-2-1",or:89},
      {name:"Golden Arrow",trainer:"P Cole",jockey:"T Queally",weight:"8-2",draw:8,odds:"14/1",form:"2-6-1-3-4-2",or:87},
    ]},
  { id:"s2", time:"14:05", course:"Ascot", name:"Royal Windsor Conditions Stakes", distance:"1m 2f", going:"Good", type:"Listed", live:false,
    runners:[
      {name:"Regal Presence",trainer:"J Gosden",jockey:"F Dettori",weight:"9-5",draw:2,odds:"2/1",form:"1-1-1-2-1-3",or:108},
      {name:"Tempest Rising",trainer:"A Balding",jockey:"O Murphy",weight:"9-3",draw:4,odds:"7/2",form:"2-3-1-1-2-1",or:106},
      {name:"Starfall",trainer:"W Haggas",jockey:"T Marquand",weight:"9-1",draw:1,odds:"5/1",form:"1-2-4-1-3-2",or:104},
      {name:"Imperial Blue",trainer:"S bin Suroor",jockey:"C Soumillon",weight:"9-0",draw:5,odds:"7/1",form:"3-1-2-5-1-4",or:103},
      {name:"Bronze Warrior",trainer:"P Cole",jockey:"T Queally",weight:"8-12",draw:3,odds:"12/1",form:"4-2-3-1-6-2",or:98},
    ]},
  { id:"s3", time:"15:20", course:"Haydock", name:"Lancashire Oaks", distance:"1m 4f", going:"Soft", type:"Group 2", live:false,
    runners:[
      {name:"Velvet Queen",trainer:"J Gosden",jockey:"F Dettori",weight:"9-0",draw:3,odds:"6/4",form:"1-1-2-1-1-2",or:116},
      {name:"Rain Dancer",trainer:"A O'Brien",jockey:"R Moore",weight:"9-0",draw:5,odds:"5/2",form:"2-1-3-2-1-1",or:114},
      {name:"Storm Petrel",trainer:"C Appleby",jockey:"W Buick",weight:"9-0",draw:1,odds:"4/1",form:"1-3-1-4-2-1",or:112},
      {name:"Lady Fortune",trainer:"R Varian",jockey:"A Atzeni",weight:"9-0",draw:2,odds:"8/1",form:"3-2-1-3-5-2",or:108},
      {name:"Crystal Waters",trainer:"Other",jockey:"Other",weight:"9-0",draw:4,odds:"16/1",form:"5-4-2-1-3-6",or:102},
    ]},
];

// ── RACE ENDPOINTS ────────────────────────────────────────────────
app.get("/api/races", async (req, res) => {
  if (cacheIsValid()) return res.json({ races: raceCache.data, source: "cache" });
  const live = await fetchFromRacingAPI();
  if (live) { raceCache = { data: live, fetchedAt: Date.now() }; return res.json({ races: live, source: "live" }); }
  return res.json({ races: SAMPLE_RACES, source: "sample" });
});

app.post("/api/races/refresh", async (req, res) => {
  raceCache = { data: null, fetchedAt: null };
  const live = await fetchFromRacingAPI();
  if (live) { raceCache = { data: live, fetchedAt: Date.now() }; return res.json({ races: live, source: "live", refreshed: true }); }
  return res.json({ races: SAMPLE_RACES, source: "sample", refreshed: true });
});

// ── ANTHROPIC PROXY ───────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server." });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1000, ...req.body }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

// ── CLAUDE TEST ENDPOINT ─────────────────────────────────────────
app.get("/api/test-claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ success: false, error: "ANTHROPIC_API_KEY not set" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 50, messages: [{ role: "user", content: "Say OK" }] }),
    });
    const data = await response.json();
    if (!response.ok) return res.json({ success: false, status: response.status, error: data });
    res.json({ success: true, status: response.status, reply: data.content?.[0]?.text });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DEBUG ENDPOINT ───────────────────────────────────────────────
app.get("/api/debug", async (req, res) => {
  const u = process.env.RACING_API_USERNAME;
  const p = process.env.RACING_API_PASSWORD;
  const result = { 
    envVarsSet: { racing_user: !!u, racing_pass: !!p, claude: !!process.env.ANTHROPIC_API_KEY },
    usernamePreview: u ? u.slice(0,4)+"****" : "NOT SET",
  };
  if (u && p) {
    try {
      const auth = Buffer.from(`${u}:${p}`).toString("base64");
      const today = new Date().toISOString().split("T")[0];
      // Basic Plan endpoint
      const testRes = await fetch(`https://api.theracingapi.com/v1/racecards/basic?region_codes=gb`, {
        headers: { "Authorization": `Basic ${auth}` }
      });
      const body = await testRes.text();
      result.apiStatus = testRes.status;
      result.apiResponse = body.slice(0, 500);
    } catch(e) {
      result.apiError = e.message;
    }
  }
  res.json(result);
});

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    racingAPI: !!(process.env.RACING_API_USERNAME && process.env.RACING_API_PASSWORD),
    racingAPIUser: process.env.RACING_API_USERNAME ? process.env.RACING_API_USERNAME.slice(0,4) + "****" : "NOT SET",
    claudeAPI: !!process.env.ANTHROPIC_API_KEY,
    claudeKeyPrefix: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.slice(0,10) + "****" : "NOT SET",
    cacheValid: cacheIsValid(),
    cachedAt: raceCache.fetchedAt ? new Date(raceCache.fetchedAt).toISOString() : null,
    nodeVersion: process.version,
  });
});

// ── SERVE REACT ───────────────────────────────────────────────────
const clientBuild = path.join(__dirname, "../client/build");
app.use(express.static(clientBuild));
app.get("*", (req, res) => res.sendFile(path.join(clientBuild, "index.html")));

app.listen(PORT, () => {
  console.log(`🏇 UK Racing Analyst running on port ${PORT}`);
  console.log(`   Racing API: ${process.env.RACING_API_USERNAME ? "✅ connected" : "⚠️  not set — using sample data"}`);
  console.log(`   Claude API: ${process.env.ANTHROPIC_API_KEY ? "✅ connected" : "⚠️  not set"}`);
});
