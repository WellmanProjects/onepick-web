import { useState, useEffect, useMemo, useRef } from "react";
import api from "./api.js";
import { CRESTS } from "./crests.js";
import {
  Trophy, Users, Lock, Check, Search, LogOut, Plus, Info,
  Crown, Shield, Home as HomeIcon, ChevronRight, RotateCcw, Flame, Calendar, ChevronDown, Newspaper, BarChart3, AlertTriangle, ExternalLink, Bell, BellOff
} from "lucide-react";

/* ============================================================
   ONEPICK — Premier League, one player a week, use each once.
   A Champagne Sports game.
   ============================================================ */
const APP_NAME = "OnePick";
const COMPANY = "Champagne Sports";
const TAGLINE = "Pick your four. Make them count.";
const SUBTAGLINE = "Every gameweek, pick one goalkeeper, one defender, one midfielder and one forward. Use each player once per period. Most points in the period wins.";
const TOTAL_GWS = 38;
/* The whole-season game (no repeats all year) is built but switched off. Set to true to bring it back next season. */
const SEASON_GAME = false;

/* Rotating lines on the pick screen. */
const NO_PICK_LINES = [
  "Who's your pick? Make the call, gaffer.",
  "Back your judgement.",
  "Your pick won't make itself.",
  "Trust your eye.",
];
const LOCKED_LINES = [
  "Locked in. Your call, gaffer.",
  "That's your pick. Stand by it.",
  "No take-backs.",
];

/* ---- Reference data. Loaded once from the database at start-up, then read directly everywhere. ---- */
const PL_POOL = [];        // [{id, name, team, pos, rating}]
const BY_ID = {};
const FIXTURES = [];       // [gameweek, homeShort, awayShort, kickoff (UTC ISO), homeDifficulty, awayDifficulty]
const TEAM_LIST = [];      // club names, A to Z
const TEAM_BY_SHORT = {};  // "ARS" -> "Arsenal"
const TEAM_NAME = {};      // team id -> club name
const TEAM_ID = {};        // club name -> team id
const GAMEWEEKS = [];      // [{id, deadline_at}]
const MONTHS = [];         // [{key, label, short, gws}]  one entry per month, in order
const lineFor = (arr, seed) => arr[seed % arr.length];

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const ratingFromCost = (c) => (c == null ? 3 : c >= 110 ? 5 : c >= 85 ? 4 : c >= 65 ? 3 : c >= 50 ? 2 : 1);

function hydrate({ teams, players, gameweeks, fixtures }) {
  PL_POOL.length = 0; FIXTURES.length = 0; TEAM_LIST.length = 0; GAMEWEEKS.length = 0; MONTHS.length = 0;
  Object.keys(BY_ID).forEach((k) => delete BY_ID[k]);
  Object.keys(TEAM_BY_SHORT).forEach((k) => delete TEAM_BY_SHORT[k]);
  Object.keys(TEAM_NAME).forEach((k) => delete TEAM_NAME[k]); Object.keys(TEAM_ID).forEach((k) => delete TEAM_ID[k]); TEAM_FIX = null;
  const nameById = {}, shortById = {};
  teams.forEach((t) => { TEAM_NAME[t.id] = t.name; TEAM_ID[t.name] = t.id; nameById[t.id] = t.name; shortById[t.id] = t.short_name; TEAM_BY_SHORT[t.short_name] = t.name; TEAM_LIST.push(t.name); });
  TEAM_LIST.sort();
  players.filter((p) => p.active !== false && nameById[p.team_id]).forEach((p) => {
    const o = { id: p.id, name: p.web_name, team: nameById[p.team_id], pos: p.position, rating: ratingFromCost(p.now_cost), pts: Number(p.total_points) || 0, form: Number(p.form) || 0, status: p.status || "a", news: p.news || "", chance: p.chance_next == null ? null : Number(p.chance_next), newsAdded: p.news_added || "" };
    PL_POOL.push(o); BY_ID[o.id] = o;
  });
  PL_POOL.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  [...gameweeks].sort((a, b) => a.id - b.id).forEach((g) => {
    GAMEWEEKS.push({ id: g.id, deadline_at: g.deadline_at });
    const key = g.month_key || g.deadline_at.slice(0, 7);
    const last = MONTHS[MONTHS.length - 1];
    if (last && last.key === key) last.gws.push(g.id);
    else {
      const label = MONTH_LABEL.format(new Date(key + "-15T12:00:00Z"));
      MONTHS.push({ key, label, short: label.split(" ")[0].slice(0, 3), gws: [g.id] });
    }
  });
  fixtures.filter((f) => f.gameweek_id != null && shortById[f.home_team_id] && shortById[f.away_team_id])
    .sort((a, b) => a.gameweek_id - b.gameweek_id || String(a.kickoff_at || "~").localeCompare(String(b.kickoff_at || "~")))
    .forEach((f) => FIXTURES.push([f.gameweek_id, shortById[f.home_team_id], shortById[f.away_team_id], f.kickoff_at, f.home_difficulty ?? null, f.away_difficulty ?? null]));
}

/* The open gameweek is the first one whose deadline is still in the future. */
const deadlineOf = (gw) => (GAMEWEEKS.find((g) => g.id === gw) || {}).deadline_at;
const isLocked = (gw, nowMs) => { const d = deadlineOf(gw); return !d || new Date(d).getTime() <= nowMs; };
function openGameweek(nowMs) {
  const g = GAMEWEEKS.find((x) => new Date(x.deadline_at).getTime() > nowMs);
  if (g) return { gw: g.id, over: false };
  return { gw: GAMEWEEKS.length ? GAMEWEEKS[GAMEWEEKS.length - 1].id : 1, over: true };
}
function untilDeadline(gw, nowMs) {
  const d = deadlineOf(gw); if (!d) return "";
  const ms = new Date(d).getTime() - nowMs; if (ms <= 0) return "Locked";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return Math.floor(h / 24) + " days left";
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

const friendlyError = (msg = "") => {
  if (/locked/i.test(msg)) return "That gameweek has locked. Picks close at the deadline.";
  if (/one player per club/i.test(msg)) return "You already have a player from that club this gameweek.";
  if (/duplicate key/i.test(msg)) return "You've already used that player.";
  if (/row-level security/i.test(msg)) return "That isn't allowed right now.";
  if (/Invalid login/i.test(msg)) return "That email and password don't match.";
  if (/already registered/i.test(msg)) return "That email already has an account. Try logging in.";
  if (/password/i.test(msg) && /6/.test(msg)) return "Your password needs at least 6 characters.";
  return msg || "Something went wrong. Try again.";
};

const BG = "#F2F5FA", PANEL = "#FFFFFF", INK = "#0B1B33", MUTED = "#5A6B85", LINE = "#E1E7F0";
const DEEP = "#0A2342", BLUE = "#1F4E9C", VOLT = "#D9F63B";
const FONT = 'Inter, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const HEAD = { fontWeight: 800, letterSpacing: "-0.025em" };
const SHADOW = "0 1px 2px rgba(16,38,28,0.06), 0 8px 24px rgba(16,38,28,0.07)";
const POS_CHIP = {
  GK: "bg-sky-100 text-sky-800",
  DEF: "bg-emerald-100 text-emerald-800",
  MID: "bg-amber-100 text-amber-800",
  FWD: "bg-rose-100 text-rose-800",
};
const PITCH = "repeating-linear-gradient(90deg, #0A2342 0 64px, #0C2A4E 64px 128px)";

function PosChip({ pos }) {
  return <span className={"text-[11px] font-bold px-1.5 py-0.5 rounded-md " + POS_CHIP[pos]}>{pos}</span>;
}

/* ---------------- Logo: OnePick wordmark (text only) ---------------- */
const LOGO_FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif';
function Logo({ h = 40, dark = false }) {
  const size = Math.round(h * 0.7);
  return (
    <span
      role="img"
      aria-label={APP_NAME}
      className="inline-block select-none whitespace-nowrap"
      style={{ fontFamily: LOGO_FONT, fontWeight: 900, fontSize: size, lineHeight: 1, letterSpacing: "-0.045em" }}
    >
      <span style={{ color: dark ? "#FFFFFF" : INK }}>One</span><span style={{ color: dark ? VOLT : BLUE }}>Pick</span>
    </span>
  );
}

/* ---------------- Landing page ---------------- */
const POS_TINT = { GK: ["#E0F2FE", "#075985"], DEF: ["#D1FAE5", "#065F46"], MID: ["#FEF3C7", "#92400E"], FWD: ["#FFE4E6", "#9F1239"] };
function PosTag({ pos }) {
  return <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-md shrink-0" style={{ background: POS_TINT[pos][0], color: POS_TINT[pos][1] }}>{pos}</span>;
}
function LandingStep({ n, title, children, visual, flip }) {
  return (
    <div className={"grid md:grid-cols-2 gap-8 md:gap-12 items-center py-8 " + (flip ? "md:[&>*:first-child]:order-2" : "")}>
      <div>
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl font-extrabold mb-4" style={{ background: VOLT, color: INK }}>{n}</div>
        <h3 className="text-2xl sm:text-[28px] mb-2.5" style={{ ...HEAD, lineHeight: 1.15 }}>{title}</h3>
        <p className="leading-relaxed max-w-md" style={{ color: MUTED }}>{children}</p>
      </div>
      <div className="rounded-2xl bg-white border p-5" style={{ borderColor: LINE, boxShadow: SHADOW }}>{visual}</div>
    </div>
  );
}
function Landing({ onStart }) {
  const jump = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const slots = [
    { pos: "GK", name: "Pickford", team: "Everton", fix: "v BHA (H)", pts: 6 },
    { pos: "DEF", name: "Gabriel", team: "Arsenal", fix: "v NEW (H)", pts: 9 },
    { pos: "MID", name: "Palmer", team: "Chelsea", fix: "@ BOU (A)", pts: 11 },
    { pos: "FWD", name: "Haaland", team: "Man City", fix: "v WHU (H)", pts: 13 },
  ];
  const DIFF = { 1: ["#0E8A4F", "#fff"], 2: ["#8FD9A3", INK], 3: ["#E3E9F2", INK], 4: ["#F4A39B", INK], 5: ["#B3153B", "#fff"] };
  const runs = [
    ["Arsenal", [["NEW (H)", 1], ["BUR (A)", 2], ["WHU (H)", 3], ["LIV (A)", 5]]],
    ["Chelsea", [["BOU (A)", 4], ["FUL (H)", 3], ["LEE (H)", 2], ["TOT (A)", 4]]],
    ["Man City", [["WHU (H)", 1], ["SUN (A)", 2], ["BHA (H)", 1], ["EVE (A)", 3]]],
  ];
  const lock = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
  const dash = { border: "2px dashed #C5D0E0" };
  const goBtn = "px-7 py-3.5 rounded-2xl font-extrabold hover:brightness-95 transition";
  return (
    <div className="min-h-screen overflow-x-hidden" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <Logo h={40} />
          <div className="flex items-center gap-1 sm:gap-2">
            <button onClick={() => jump("how")} className="hidden sm:block px-3 py-2 rounded-xl text-sm font-semibold hover:bg-black/5 transition-colors" style={{ color: MUTED }}>How it works</button>
            <button onClick={() => onStart("login")} className="px-3 sm:px-4 py-2 rounded-xl text-sm font-semibold hover:bg-black/5 transition-colors">Log in</button>
            <button onClick={() => onStart("signup")} className="px-4 py-2 rounded-xl text-sm font-bold text-white hover:brightness-110 transition" style={{ background: BLUE }}>Play free</button>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden text-white" style={{ background: PITCH }}>
        <div className="relative max-w-5xl mx-auto px-4 py-14 sm:py-20 grid md:grid-cols-2 gap-10 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-5" style={{ background: "rgba(255,255,255,0.12)" }}>
              <span className="w-2 h-2 rounded-full" style={{ background: VOLT }} /> Premier League · 2026/27 · Free to play
            </div>
            <h1 className="text-4xl sm:text-6xl mb-4" style={{ ...HEAD, lineHeight: 1.03 }}>One pick per position. <span style={{ color: VOLT }}>Every week.</span></h1>
            <p className="text-lg mb-7 max-w-md" style={{ color: "rgba(255,255,255,0.86)" }}>Each gameweek, pick one goalkeeper, one defender, one midfielder and one forward. Use each player just once per period. Most points over the period wins.</p>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => onStart("signup")} className={goBtn} style={{ background: VOLT, color: INK }}>Play free</button>
              <button onClick={() => jump("how")} className="px-7 py-3.5 rounded-2xl font-semibold border border-white/40 hover:bg-white/10 transition-colors">See how it works</button>
            </div>
            <p className="text-xs mt-5" style={{ color: "rgba(255,255,255,0.72)" }}>Takes a minute to join. No payment, no squad to build.</p>
          </div>

          <div className="rounded-2xl bg-white p-5 text-left w-full max-w-md md:ml-auto" style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.35)", color: INK }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-bold tracking-wide" style={{ color: MUTED }}>GAMEWEEK 11 · EXAMPLE</div>
              <div className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: "rgba(31,78,156,0.12)", color: BLUE }}>Picks locked</div>
            </div>
            {slots.map((s, i) => (
              <div key={s.pos} className={"flex items-center gap-3 py-2.5 " + (i < 3 ? "border-b" : "")} style={{ borderColor: LINE }}>
                <div className="w-11 flex"><PosTag pos={s.pos} /></div>
                <Crest team={s.team} size={32} />
                <div className="flex-1 min-w-0"><div className="font-bold leading-tight">{s.name}</div><div className="text-xs truncate" style={{ color: MUTED }}>{s.team} · {s.fix}</div></div>
                <div className="text-xl font-extrabold tabular-nums" style={{ color: BLUE }}>{s.pts}</div>
              </div>
            ))}
            <div className="mt-2 rounded-xl px-3.5 py-3 flex items-center justify-between" style={{ background: BG }}>
              <span className="text-sm font-semibold" style={{ color: MUTED }}>Gameweek total</span>
              <span className="text-2xl font-extrabold tabular-nums leading-none" style={{ color: BLUE }}>39 <span className="text-xs font-semibold" style={{ color: MUTED }}>pts</span></span>
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-xs mb-1.5" style={{ color: MUTED }}><span>Players used this period (GW9–12)</span><span className="font-bold" style={{ color: INK }}>12 of 16</span></div>
              <div className="h-2 rounded-full" style={{ background: LINE }}><div className="h-2 rounded-full" style={{ width: "75%", background: BLUE }} /></div>
            </div>
          </div>
        </div>
      </section>

      <main className="max-w-5xl mx-auto px-4">
        <div id="how" className="pt-16 pb-2 scroll-mt-20">
          <div className="text-xs font-bold tracking-widest mb-2" style={{ color: BLUE }}>HOW IT WORKS</div>
          <h2 className="text-3xl sm:text-4xl mb-2.5" style={{ ...HEAD, lineHeight: 1.1 }}>Five steps. That's the whole game.</h2>
          <p className="text-lg max-w-xl" style={{ color: MUTED }}>No squad to manage and no transfers. Just four decisions a week, and a fresh race every four gameweeks.</p>
        </div>

        <LandingStep n="1" title="Pick your four" visual={
          <div className="grid grid-cols-2 gap-3">
            {[["GK", "Pickford", "Everton"], ["DEF", "Gabriel", "Arsenal"]].map(([pos, name, team]) => (
              <div key={pos} className="rounded-xl p-3" style={{ border: "2px solid " + BLUE, background: "rgba(31,78,156,0.06)" }}><PosTag pos={pos} /><div className="font-extrabold mt-2">{name}</div><div className="text-xs" style={{ color: MUTED }}>{team}</div></div>
            ))}
            {[["MID", "midfielder"], ["FWD", "forward"]].map(([pos, w]) => (
              <div key={pos} className="rounded-xl p-3" style={dash}><PosTag pos={pos} /><div className="font-bold mt-2" style={{ color: BLUE }}>Pick a {w}</div><div className="text-xs" style={{ color: MUTED }}>Tap to choose</div></div>
            ))}
          </div>}>
          Every gameweek, choose one goalkeeper, one defender, one midfielder and one forward from any Premier League club. You can't pick two players from the same club in the same week, so spread your bets.
        </LandingStep>

        <LandingStep n="2" title="Use each player just once" flip visual={
          <div>
            {[["Saka", "Used in GW9"], ["Ødegaard", "Arsenal already picked"]].map(([n, why]) => (
              <div key={n} className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border mb-2 opacity-70" style={{ borderColor: LINE, background: "#F7F9FC" }}>
                <PosTag pos="MID" /><span className="font-bold flex-1">{n}</span><span className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: MUTED }}>{lock}{why}</span>
              </div>
            ))}
            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border" style={{ borderColor: LINE }}><PosTag pos="MID" /><span className="font-bold flex-1">Palmer</span><span className="text-xs font-bold" style={{ color: BLUE }}>Available</span></div>
            <div className="mt-4 rounded-xl px-3.5 py-3 flex flex-wrap items-center justify-between gap-2" style={{ background: "rgba(217,246,59,0.35)" }}>
              <span className="text-sm font-bold">Every 4 gameweeks</span><span className="text-sm font-semibold">Fresh start. Every player is back.</span>
            </div>
          </div>}>
          Once a player has been one of your picks, he's off the table for the rest of the period. In the main game a period is four gameweeks. In a private league, you choose the length. Spend the big names early, or save them for the run-in. When a new period starts, everyone comes back.
        </LandingStep>

        <LandingStep n="3" title="Plan ahead, or decide on the day" visual={
          <div>
            <div className="flex text-xs font-bold mb-2 gap-2" style={{ color: MUTED, paddingLeft: 82 }}>{["GW12", "GW13", "GW14", "GW15"].map((g) => <span key={g} className="flex-1 text-center">{g}</span>)}</div>
            {runs.map(([team, fx]) => (
              <div key={team} className="flex items-center gap-2 mb-1.5">
                <span className="text-[13px] font-bold shrink-0" style={{ width: 74 }}>{team}</span>
                {fx.map(([t, d], i) => <span key={i} className="flex-1 text-center py-2 rounded-lg text-[11px] font-extrabold whitespace-nowrap" style={{ background: DIFF[d][0], color: DIFF[d][1] }}>{t}</span>)}
              </div>
            ))}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs" style={{ color: MUTED }}>Green is an easier run, red is harder. Example fixtures.</span>
              <span className="text-[13px] font-bold px-3.5 py-2 rounded-lg text-white" style={{ background: BLUE }}>Save GW12</span>
            </div>
          </div>}>
          See how tough each club's next gameweeks are, check the latest injury and line-up news, and draft your next few weeks before you commit. Picks can be changed right up to the deadline.
        </LandingStep>

        <LandingStep n="4" title="Score every goal, assist and clean sheet" flip visual={
          <div>
            <div className="grid items-center text-sm" style={{ gridTemplateColumns: "1.6fr repeat(4, minmax(0, 1fr))" }}>
              <div className="py-2 text-xs font-bold border-b" style={{ color: MUTED, borderColor: LINE }}>Points for a</div>
              {["GK", "DEF", "MID", "FWD"].map((p) => <div key={p} className="py-2 text-center text-xs font-extrabold border-b" style={{ color: POS_TINT[p][1], borderColor: LINE }}>{p}</div>)}
              {[["Goal", [10, 6, 5, 4]], ["Assist", [3, 3, 3, 3]], ["Clean sheet", [4, 4, 1, "–"]]].map(([label, v], r) => (
                <div key={label} className="contents">
                  <div className={"py-2.5 font-semibold " + (r < 2 ? "border-b" : "")} style={{ borderColor: "#EEF2F8" }}>{label}</div>
                  {v.map((x, i) => <div key={i} className={"py-2.5 text-center font-extrabold tabular-nums " + (r < 2 ? "border-b" : "")} style={{ color: x === "–" ? "#98A6BC" : BLUE, borderColor: "#EEF2F8" }}>{x}</div>)}
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs" style={{ color: MUTED }}>Plus bonus points, saves, cards and more. The full table is in the game.</div>
          </div>}>
          All four of your picks score every gameweek, using the same points as Fantasy Premier League. A goal from a defender is worth more than one from a striker, so the position you pick matters.
        </LandingStep>

        <LandingStep n="5" title="Win the period" visual={
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-bold tracking-wide" style={{ color: MUTED }}>GW9–12 · EXAMPLE TABLE</div>
              <div className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: "rgba(217,246,59,0.5)" }}>Period in progress</div>
            </div>
            {[["1", "dan", 312, false], ["2", "you", 298, true], ["3", "mo", 287, false]].map(([r, n, p, me]) => (
              <div key={n} className={"flex items-center gap-3 py-3 border-b last:border-0 " + (me ? "-mx-2 px-2 rounded-lg" : "")} style={{ borderColor: "#EEF2F8", background: me ? "rgba(31,78,156,0.06)" : undefined }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-extrabold" style={{ background: r === "1" ? VOLT : "#E3E9F2" }}>{r}</span>
                <span className="flex-1 font-bold">{n}</span><span className="text-xl font-extrabold tabular-nums" style={{ color: BLUE }}>{p}</span>
              </div>
            ))}
            <div className="mt-2.5 flex flex-wrap gap-2">{[["GW1–4", "dan"], ["GW5–8", "mo"]].map(([g, n]) => <span key={g} className="text-xs rounded-full border px-2.5 py-1" style={{ borderColor: LINE, background: "#F7F9FC" }}>{g} <b>{n}</b></span>)}</div>
          </div>}>
          Add up all your picks across the period's gameweeks. The top score wins, and then everyone starts again. Start a private league with your mates and share the code to settle it on the table. You can even make it weekly, so the same player can be picked every week.
        </LandingStep>
      </main>

      <section className="bg-white border-y mt-10" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 py-14">
          <h2 className="text-2xl sm:text-3xl mb-6" style={HEAD}>Everything you need to make the call</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[["Fixture difficulty", "Every club's next gameweeks rated from easiest to hardest."], ["Team news", "Injuries, suspensions and line-up headlines, in one place."], ["Top scorers by position", "See last week's best players before you choose."], ["No peeking", "Rivals can't see your picks until the deadline passes."]].map(([t, d]) => (
              <div key={t}><div className="font-extrabold mb-1">{t}</div><div className="text-sm" style={{ color: MUTED }}>{d}</div></div>
            ))}
          </div>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 pt-14 pb-4">
        <h2 className="text-2xl sm:text-3xl mb-6" style={HEAD}>Quick questions</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[["Is it free?", "Yes. There's nothing to pay and no squad budget to manage."], ["Do I need to know Fantasy Premier League?", "No. If you can name a few players, you can play. Scoring is the same as FPL, but there are no transfers or chips."], ["When do picks lock?", "At the gameweek deadline, shown on the pick screen. Until then you can change them as often as you like. An empty slot scores zero."]].map(([q, a]) => (
            <div key={q} className="rounded-2xl bg-white border p-5" style={{ borderColor: LINE }}><div className="font-extrabold mb-1.5">{q}</div><div className="text-sm" style={{ color: MUTED }}>{a}</div></div>
          ))}
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 pt-8 pb-14">
        <div className="rounded-3xl px-7 sm:px-9 py-9 flex flex-wrap items-center justify-between gap-5 text-white" style={{ background: PITCH }}>
          <div><div className="text-2xl sm:text-3xl" style={HEAD}>Ready to pick your four?</div><div className="mt-1.5" style={{ color: "rgba(255,255,255,0.8)" }}>A fresh start every four gameweeks. Join in a minute.</div></div>
          <button onClick={() => onStart("signup")} className={goBtn} style={{ background: VOLT, color: INK }}>Play free</button>
        </div>
      </section>

      <footer className="border-t" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 py-6 text-center text-xs" style={{ color: MUTED }}>
          {APP_NAME} is a {COMPANY} game · early prototype. An independent game, not affiliated with or endorsed by the Premier League or any club.
        </div>
      </footer>
    </div>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center p-6 text-center" style={{ background: BG, fontFamily: FONT, color: INK }}><div className="max-w-sm">{children}</div></div>;
}

export default function App() {
  const [boot, setBoot] = useState({ state: "loading" });   // loading | ready | empty | error
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState(null);                   // {id, email, username}
  const [authMode, setAuthMode] = useState(null);           // null = show landing page
  const [tab, setTab] = useState("home");
  const [now, setNow] = useState(Date.now());
  const [picks, setPicks] = useState({});                   // {gameweek: playerId}
  const [lpicks, setLpicks] = useState({});                 // {leagueId: {gameweek: {slot: playerId}}}  slot = GK/DEF/MID/FWD, or ANY
  const [leagues, setLeagues] = useState([]);
  const [tables, setTables] = useState({});                 // {main | leagueId: rows from gw_points_table}
  const [myPts, setMyPts] = useState({});                   // {"playerId|gameweek": {points, provisional, breakdown}}
  const [news, setNews] = useState([]);                    // team news headlines
  const [toast, setToast] = useState("");
  const [digestOn, setDigestOn] = useState(null);          // email reminders: null = not available yet (database update 009)
  const [prefOpen, setPrefOpen] = useState(false);
  const [unsub, setUnsub] = useState(() => { try { const m = window.location.hash.match(/unsubscribe=([0-9a-f-]{36}|[\w-]+)/i); return m ? { token: m[1], state: "working" } : null; } catch { return null; } });
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 4500); };

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const data = await api.loadStatic();
        if (off) return;
        hydrate(data);
        setBoot({ state: PL_POOL.length && GAMEWEEKS.length ? "ready" : "empty" });
      } catch (e) { if (!off) setBoot({ state: "error", msg: e.message }); }
    })();
    const unsub = api.onAuth(async (sess) => {
      if (!sess) { setUser(null); setAuthChecked(true); return; }
      let prof = null;
      try { prof = await api.getProfile(sess.id); } catch {}
      setUser({ id: sess.id, email: sess.email, username: (prof && prof.username) || sess.email, joined: prof && prof.created_at ? new Date(prof.created_at).getTime() : 0 });
      setAuthChecked(true);
    });
    const loadNews = () => api.loadNews().then((r) => { if (!off) setNews(r); }).catch(() => {});
    loadNews(); const newsTick = setInterval(loadNews, 300000);
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => { off = true; if (unsub) unsub(); clearInterval(tick); clearInterval(newsTick); };
  }, []);

  const refresh = async () => {
    if (!user) return;
    try {
      const [mine, lgs] = await Promise.all([api.loadMine(user.id), api.loadLeagues()]);
      setPicks(mine.picks); setLpicks(mine.lpicks); setLeagues(lgs);
      const keys = [null, ...lgs.map((l) => l.id)];
      const rows = await Promise.all(keys.map((k) => api.loadTable(k)));
      setTables(Object.fromEntries(keys.map((k, i) => [k || "main", rows[i]])));
      const ids = [...new Set([...Object.values(mine.picks), ...Object.values(mine.lpicks).flatMap((o) => Object.values(o).flatMap((sl) => Object.values(sl)))])];
      setMyPts(await api.loadMyPoints(ids));
    } catch (e) { flash(friendlyError(e.message)); }
  };
  useEffect(() => {
    if (!unsub || unsub.state !== "working") return;
    api.unsubscribe(unsub.token).then((ok) => setUnsub({ ...unsub, state: ok ? "done" : "bad" })).catch(() => setUnsub({ ...unsub, state: "bad" }));
  }, []);
  useEffect(() => {
    if (!user) { setDigestOn(null); setPrefOpen(false); return; }
    api.getDigest().then(setDigestOn).catch(() => setDigestOn(null));
  }, [user && user.id]);
  useEffect(() => {
    if (!user) { setPicks({}); setLpicks({}); setLeagues([]); setTables({}); setMyPts({}); return; }
    refresh();
    const t = setInterval(refresh, 120000);
    return () => clearInterval(t);
  }, [user && user.id]);

  if (unsub) return <Centered><Logo h={48} />
    <p className="mt-4 font-semibold">{unsub.state === "working" ? "Updating your email settings…" : unsub.state === "done" ? "You're unsubscribed." : "That unsubscribe link didn't work."}</p>
    <p className="text-sm mt-1" style={{ color: MUTED }}>{unsub.state === "done" ? "We won't send you gameweek emails any more. You can turn them back on any time from the bell icon once you're signed in." : unsub.state === "bad" ? "You can switch emails off from the bell icon once you're signed in." : ""}</p>
    {unsub.state !== "working" && <button onClick={() => { window.location.hash = ""; setUnsub(null); }} className="mt-4 px-4 py-2 rounded-xl text-white font-bold" style={{ background: BLUE }}>Go to {APP_NAME}</button>}</Centered>;
  if (boot.state === "loading" || !authChecked)
    return <Centered><div className="animate-pulse text-sm" style={{ color: MUTED }}>Loading {APP_NAME}…</div></Centered>;
  if (boot.state === "error")
    return <Centered><Logo h={48} /><p className="mt-4 font-semibold">Can't reach the game just now.</p>
      <p className="text-sm mt-1" style={{ color: MUTED }}>{boot.msg}</p>
      <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 rounded-xl text-white font-bold" style={{ background: BLUE }}>Try again</button></Centered>;
  if (boot.state === "empty")
    return <Centered><Logo h={48} /><p className="mt-4 font-semibold">The player list hasn't been loaded yet.</p>
      <p className="text-sm mt-1" style={{ color: MUTED }}>The nightly job needs to run once. In GitHub, open Actions, choose "Nightly ingest", then Run workflow.</p></Centered>;

  const doSignUp = async ({ email, password, username }) => {
    try {
      if (await api.usernameTaken(username)) return "That username is taken.";
      const r = await api.signUp({ email, password, username });
      if (r.error) return friendlyError(r.error);
      return r.needsConfirm ? "CONFIRM" : null;
    } catch (e) { return friendlyError(e.message); }
  };
  const doLogin = async (cred) => { try { const r = await api.signIn(cred); return r.error ? friendlyError(r.error) : null; } catch (e) { return friendlyError(e.message); } };

  if (!user) {
    if (!authMode) return <Landing onStart={(m) => setAuthMode(m)} />;
    return <AuthScreen initialMode={authMode} onBack={() => setAuthMode(null)} onSignUp={doSignUp} onLogin={doLogin} />;
  }

  const { gw: currentGW, over } = openGameweek(now);
  const nowMs = now;
  const usedIds = new Set(Object.values(picks));
  const closed = over || isLocked(currentGW, nowMs);

  const mainRows = tables.main || [];
  const official = leagues.find((l) => l.official) || null;
  const officialRows = official ? (tables[official.id] || []) : null;
  const curPeriod = official ? periodOf(official.format, currentGW) : null;
  const headRows = officialRows || mainRows;
  const headGws = officialRows && curPeriod ? new Set(curPeriod.gws) : null;
  const mainBoard = (() => {
    const t = new Map();
    headRows.forEach((r) => { if (!headGws || r.gameweek_id == null || headGws.has(r.gameweek_id)) t.set(r.user_id, (t.get(r.user_id) || 0) + (r.points || 0)); else if (!t.has(r.user_id)) t.set(r.user_id, 0); });
    return [...t.entries()].map(([id, total]) => ({ id, total }));
  })();
  const boardNames = {}; headRows.forEach((r) => { if (r.username) boardNames[r.user_id] = r.username; });
  const homeBoard = mainBoard.map((r) => ({ ...r, name: boardNames[r.id] || "Player" })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const myTotal = mainBoard.find((r) => r.id === user.id)?.total || 0;
  const myRank = 1 + mainBoard.filter((r) => r.total > myTotal).length;

  const guard = () => { if (closed) { flash("Picks are closed. The deadline has passed."); return false; } return true; };
  const pickPlayer = async (pid) => {
    if (!guard()) return;
    if (usedIds.has(pid) && picks[currentGW] !== pid) return;
    try {
      if (picks[currentGW] === pid) { await api.clearPick(user.id, currentGW); const n = { ...picks }; delete n[currentGW]; setPicks(n); }
      else { await api.savePick(user.id, currentGW, pid); setPicks({ ...picks, [currentGW]: pid }); }
    } catch (e) { flash(friendlyError(e.message)); }
  };

  const resetLeagues = leagues.filter((l) => l.reset && l.format.type !== "season" && !l.official);
  const privateLeagues = leagues.filter((l) => !l.official);
  const usesMainPicks = (l) => !(l.reset && l.format.type !== "season");
  const showSeasonCtx = SEASON_GAME || !official || privateLeagues.some(usesMainPicks);
  const seasonLabel = !official ? "Main game" : SEASON_GAME ? "OnePick Season" : "Season picks";
  const seasonSub = SEASON_GAME || !official ? "No repeats all season" : "Used by your leagues without resets";
  const roundOf = (lg) => roundsFor(lg.format).find((r) => r.gws.includes(currentGW)) || { gws: [currentGW], label: "GW" + currentGW };
  const pickForLeague = (lg) => async (pid) => {
    if (!guard()) return;
    const pl = BY_ID[pid]; if (!pl) return;
    const slot = lg.bySlot ? pl.pos : "ANY";
    const mine = { ...(lpicks[lg.id] || {}) }; const cur = { ...(mine[currentGW] || {}) }; const gws = roundOf(lg).gws;
    if (gws.filter((g) => g !== currentGW).some((g) => Object.values(mine[g] || {}).includes(pid))) return;
    if (lg.bySlot && Object.entries(cur).some(([sl, id]) => sl !== slot && BY_ID[id] && BY_ID[id].team === pl.team)) { flash("You already have a " + pl.team + " player this gameweek. Pick someone from another club."); return; }
    try {
      if (cur[slot] === pid) { await api.clearLeaguePick(user.id, lg.id, currentGW, slot); delete cur[slot]; }
      else { await api.saveLeaguePick(user.id, lg.id, currentGW, pid, slot); cur[slot] = pid; }
      mine[currentGW] = cur;
      setLpicks({ ...lpicks, [lg.id]: mine });
    } catch (e) { flash(friendlyError(e.message)); }
  };
  const leagueCtx = (lg, label, sub) => {
    const mine = lpicks[lg.id] || {}; const r = roundOf(lg);
    const roundPicks = {}; r.gws.forEach((g) => { const ids = Object.values(mine[g] || {}); if (ids.length) roundPicks[g] = ids; });
    const all = Object.values(roundPicks).flat(); const per = lg.bySlot ? 4 : 1;
    return { id: lg.id, label: label || lg.name, sub: sub || (lg.format.type === "gws" && lg.format.n === 1 ? resetNote(lg.format) : "Resets after " + r.label), usedIds: new Set(all), curIds: new Set(Object.values(mine[currentGW] || {})), roundPicks, bySlot: lg.bySlot, onPick: pickForLeague(lg),
      progress: { label: lg.format.type === "gws" && lg.format.n === 1 ? "Picks this week" : "Picks used this " + (lg.official ? "period" : "round") + " (" + r.label + ")", used: all.length, total: r.gws.length * per } };
  };
  const ctxs = [
    ...(official ? [leagueCtx(official, "Main game", resetNote(official.format))] : []),
    ...(showSeasonCtx ? [{ id: "main", label: seasonLabel, sub: seasonSub, usedIds, curIds: new Set(picks[currentGW] ? [picks[currentGW]] : []), roundPicks: Object.fromEntries(Object.entries(picks).map(([g, p]) => [g, [p]])), bySlot: false, onPick: pickPlayer, progress: { label: "Picks used", used: usedIds.size, total: TOTAL_GWS } }] : []),
    ...resetLeagues.map((lg) => leagueCtx(lg)),
  ];

  // what your picks scored in the last gameweek, once those points are in
  const lastWeekPts = (() => {
    const g = currentGW - 1; if (g < 1) return null;
    const ids = official ? Object.values((lpicks[official.id] || {})[g] || {}) : (picks[g] ? [picks[g]] : []);
    const got = ids.map((id) => myPts[id + "|" + g]).filter(Boolean);
    return got.length ? got.reduce((n, r) => n + (r.points || 0), 0) : null;
  })();

  // The planner saves several gameweeks at once. Old picks in changed slots are cleared first, so players can move between weeks.
  const savePlan = async (changes) => {
    if (!official) return { ok: 0, failed: changes.length };
    let ok = 0, failed = 0;
    const live = changes.filter((c) => !isLocked(c.gw, nowMs));
    failed += changes.length - live.length;
    const mine = lpicks[official.id] || {};
    for (const c of live) {
      const old = (mine[c.gw] || {})[c.pos];
      if (old && old !== c.pid) { try { await api.clearLeaguePick(user.id, official.id, c.gw, c.pos); } catch { /* the save below reports it */ } }
    }
    for (const c of live) {
      try {
        if (c.pid != null) await api.saveLeaguePick(user.id, official.id, c.gw, c.pid, c.pos);
        ok++;
      } catch { failed++; }
    }
    await refresh();
    return { ok, failed };
  };

  const logout = async () => { await api.signOut(); setAuthMode(null); setTab("home"); };
  const createLeague = async (name, format, reset) => { const code = await api.createLeague(name, format, reset); await refresh(); return code; };
  const joinLeague = async (code) => {
    try { await api.joinLeague(code); await refresh(); return ""; } catch (e) { return /No league/i.test(e.message) ? "No league found with that code." : friendlyError(e.message); }
  };

  const tabs = [{ id: "home", label: "Home", icon: HomeIcon }, { id: "pick", label: "Pick", icon: Check }, ...(official && official.bySlot ? [{ id: "plan", label: "Plan", icon: Flame }] : []), { id: "fixtures", label: "Fixtures", icon: BarChart3 }, { id: "news", label: "Team news", icon: Newspaper }, { id: "season", label: "My picks", icon: Calendar }, { id: "leagues", label: "Leagues", icon: Users }, { id: "rules", label: "Rules", icon: Info }];

  return (
    <div className="min-h-screen" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b" style={{ borderColor: LINE }}>
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo h={40} />
            <div className="hidden sm:block text-xs leading-snug border-l pl-3" style={{ borderColor: LINE, color: MUTED }}>Premier League<br />Gameweek {currentGW}</div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-baseline gap-1.5 rounded-xl px-3 py-1.5" style={{ background: "rgba(31,78,156,0.1)" }}>
              <span className="text-xl font-extrabold tabular-nums leading-none" style={{ color: BLUE }}>{myTotal}</span>
              <span className="text-[11px] font-medium" style={{ color: MUTED }}>pts{officialRows && curPeriod ? " in " + curPeriod.label : ""} · #{myRank} of {Math.max(mainBoard.length, 1)}</span>
            </div>
            <div className="hidden sm:block text-sm font-medium">{user.username}</div>
            {digestOn !== null && <div className="relative">
              <button onClick={() => setPrefOpen((o) => !o)} title="Email reminders" aria-label="Email reminders" className="p-2 rounded-lg hover:bg-black/5 transition-colors" style={{ color: digestOn ? BLUE : MUTED }}>{digestOn ? <Bell size={18} /> : <BellOff size={18} />}</button>
              {prefOpen && <div className="absolute right-0 top-11 w-72 rounded-2xl bg-white border shadow-lg p-4 z-30" style={{ borderColor: LINE }}>
                <div className="font-bold text-sm">Gameweek emails</div>
                <p className="text-xs mt-1 leading-relaxed" style={{ color: MUTED }}>The day before picks lock we email your fixtures, your picks, your points and the players most likely to score.</p>
                <button onClick={async () => { const next = !digestOn; setDigestOn(next); try { await api.setDigest(next); } catch (e) { setDigestOn(!next); flash(friendlyError(e.message)); } }}
                  className="mt-3 w-full px-3 py-2 rounded-xl text-sm font-bold text-white" style={{ background: digestOn ? "#5A6B85" : BLUE }}>{digestOn ? "Turn emails off" : "Turn emails on"}</button>
                <div className="text-[11px] mt-2" style={{ color: MUTED }}>Sent to {user.email}</div>
              </div>}
            </div>}
            <button onClick={logout} title="Log out" className="p-2 rounded-lg hover:bg-black/5 transition-colors" style={{ color: MUTED }}><LogOut size={18} /></button>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = t.icon, active = tab === t.id;
            return <button key={t.id} onClick={() => setTab(t.id)}
              className={"flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors " + (active ? "text-white" : "hover:bg-black/5")}
              style={active ? { background: DEEP } : { color: MUTED }}>
              <Icon size={15} /> {t.label}</button>;
          })}
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {tab === "home" && <HomeView user={user} currentGW={currentGW} now={now} closed={closed} over={over} official={official} ctx={ctxs[0]} myPts={myPts} news={news} board={homeBoard} myRank={myRank} myTotal={myTotal} periodLabel={curPeriod ? curPeriod.label : null} lastWeekPts={lastWeekPts} onGo={setTab} />}
        {tab === "pick" && <PickView currentGW={currentGW} ctxs={ctxs} closed={closed} now={now} news={news} onNews={() => setTab("news")} />}
        {tab === "fixtures" && <FixturesView currentGW={currentGW} />}
        {tab === "news" && <NewsView news={news} now={now} />}
        {tab === "plan" && official && official.bySlot && <PlanView news={news} format={official.format} uid={user.id} mine={lpicks[official.id] || {}} currentGW={currentGW} now={now} onSave={savePlan} />}
        {tab === "season" && <MyPicksView official={official} showSeason={showSeasonCtx} seasonLabel={seasonLabel} picks={picks} lpicks={lpicks} currentGW={currentGW} pts={myPts} now={now} joined={user.joined} />}
        {tab === "leagues" && <LeaguesView myId={user.id} leagues={privateLeagues} official={official} tables={tables} picks={picks} lpicks={lpicks} currentGW={currentGW} onCreate={createLeague} onJoin={joinLeague} />}
        {tab === "rules" && <RulesView />}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-6 text-center text-xs" style={{ color: MUTED }}>
        {APP_NAME} is a {COMPANY} game · early prototype
      </footer>
      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-50 max-w-sm px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg" style={{ background: "#BE123C" }} role="alert">{toast}</div>}
    </div>
  );
}

function AuthScreen({ onSignUp, onLogin, initialMode, onBack }) {
  const [mode, setMode] = useState(initialMode || "signup");
  const [email, setEmail] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false);
  const submit = async () => {
    setErr("");
    const em = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(em)) return setErr("Enter a valid email address.");
    if (password.length < 6) return setErr("Your password needs at least 6 characters.");
    const u = username.trim();
    if (mode === "signup" && !/^[A-Za-z0-9_]{3,20}$/.test(u)) return setErr("Username: 3 to 20 letters, numbers or underscores.");
    setBusy(true);
    const res = mode === "signup" ? await onSignUp({ email: em, password, username: u }) : await onLogin({ email: em, password });
    setBusy(false);
    if (res === "CONFIRM") setSent(true); else if (res) setErr(res);
  };
  const input = "w-full mb-4 px-3.5 py-2.5 rounded-xl bg-white border focus:outline-none focus:ring-2";
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: BG, fontFamily: FONT, color: INK }}>
      <div className="w-full max-w-sm">
        <button onClick={onBack} className="text-sm mb-4 hover:opacity-70 transition-opacity" style={{ color: MUTED }}>← Back</button>
        <div className="flex flex-col items-center mb-5">
          <Logo h={64} />
          <p className="text-center text-sm mt-3" style={{ color: MUTED }}>{TAGLINE}</p>
        </div>
        <div className="rounded-2xl bg-white p-6 border" style={{ borderColor: LINE, boxShadow: SHADOW }}>
          {sent ? <div className="text-center py-4"><div className="font-bold mb-1">Check your email</div><div className="text-sm" style={{ color: MUTED }}>We've sent a link to confirm your account. Click it, then log in.</div></div> : <>
          <div className="flex rounded-xl p-1 mb-5" style={{ background: "#EEF2F8" }}>
            {["signup", "login"].map((m) => <button key={m} onClick={() => { setMode(m); setErr(""); }}
              className={"flex-1 py-2 text-sm font-semibold rounded-lg transition-all " + (mode === m ? "bg-white shadow-sm" : "")}
              style={mode === m ? { color: INK } : { color: MUTED }}>{m === "signup" ? "Sign up" : "Log in"}</button>)}
          </div>
          <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="you@example.com" autoComplete="email"
            className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          {mode === "signup" && <>
            <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Username <span className="font-normal">(what your mates see)</span></label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="e.g. tactical_genius" autoComplete="username"
              className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          </>}
          <label className="block text-xs font-semibold mb-1" style={{ color: MUTED }}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="At least 6 characters" autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className={input} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          {err && <div className="text-sm mb-3 text-rose-600" role="alert">{err}</div>}
          <button onClick={submit} disabled={busy} className="w-full py-3 rounded-xl text-white font-bold hover:brightness-110 transition disabled:opacity-60" style={{ background: BLUE }}>{busy ? "One moment…" : mode === "signup" ? "Create account" : "Log in"}</button>
          </>}
        </div>
        <p className="text-center text-xs mt-4 leading-relaxed" style={{ color: MUTED }}>Early prototype. Your email is only used to log you in.</p>
      </div>
    </div>
  );
}

/* ---------------- Club crests + fixtures helpers ---------------- */
const POS_ORDER = ["FWD", "MID", "DEF", "GK"];
const POS_ONE = { GK: "goalkeeper", DEF: "defender", MID: "midfielder", FWD: "forward" };
const POS_LABEL = { FWD: "Forwards", MID: "Midfielders", DEF: "Defenders", GK: "Goalkeepers" };
const UK_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
const UK_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const UK_WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const ukPart = (fmt, iso, type) => (fmt.formatToParts(new Date(iso)).find((x) => x.type === type) || {}).value || "";
const koDay = (iso) => `${ukPart(UK_DAY, iso, "weekday")} ${ukPart(UK_DAY, iso, "day")} ${ukPart(UK_DAY, iso, "month")}`;
const koTime = (iso) => `${ukPart(UK_TIME, iso, "hour")}:${ukPart(UK_TIME, iso, "minute")}`;
const koShort = (iso) => `${ukPart(UK_WEEKDAY, iso, "weekday")} ${koTime(iso)}`;

function Crest({ team, size = 28 }) {
  const badge = CRESTS[team];
  return (
    <span className="inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      {badge ? <img src={badge} alt="" draggable="false" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : null}
    </span>
  );
}

function FixtureRow({ f }) {
  const [, h, a, ko] = f;
  const hn = TEAM_BY_SHORT[h], an = TEAM_BY_SHORT[a];
  const name = (short, full, right) => (
    <span className={"text-xs md:text-sm font-semibold leading-tight " + (right ? "text-right" : "text-left")}>{full}</span>
  );
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl bg-white border px-2 md:px-3 py-2" style={{ borderColor: LINE }}>
      <div className="flex items-center justify-end gap-1.5 md:gap-2 min-w-0">{name(h, hn, true)}<Crest team={hn} size={24} /></div>
      <div className="text-xs font-bold tabular-nums px-2 py-1 rounded-md" style={{ background: "rgba(31,78,156,0.1)", color: BLUE }}>{ko ? koTime(ko) : "TBC"}</div>
      <div className="flex items-center gap-2 min-w-0"><Crest team={an} size={24} />{name(a, an, false)}</div>
    </div>
  );
}

function FixturesPanel({ gw, fixtures }) {
  const [open, setOpen] = useState(true);
  const days = useMemo(() => {
    const out = [];
    fixtures.forEach((f) => {
      const d = f[3] ? koDay(f[3]) : "Date to be confirmed";
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(f); else out.push({ day: d, items: [f] });
    });
    return out;
  }, [fixtures]);
  return (
    <div className="rounded-2xl bg-white border mb-5" style={{ borderColor: LINE, boxShadow: SHADOW }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2 font-bold"><Calendar size={16} style={{ color: BLUE }} /> Gameweek {gw} fixtures</span>
        <span className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          {fixtures.length} {fixtures.length === 1 ? "match" : "matches"} · UK time
          <ChevronRight size={16} className={"transition-transform " + (open ? "rotate-90" : "")} />
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t space-y-3" style={{ borderColor: LINE }}>
          {days.length === 0 && <div className="text-sm" style={{ color: MUTED }}>No fixtures scheduled for this gameweek.</div>}
          {days.map((d) => (
            <div key={d.day}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>{d.day}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{d.items.map((f, i) => <FixtureRow key={i} f={f} />)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FixtureLine({ fixtures }) {
  if (!fixtures.length) return <div className="text-xs mt-0.5 font-medium" style={{ color: "#B45309" }}>No fixture this week</div>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs mt-0.5" style={{ color: MUTED }}>
      {fixtures.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className="font-semibold" style={{ color: INK }}>{x.home ? "v" : "@"}</span>
          <Crest team={TEAM_BY_SHORT[x.opp]} size={14} />
          <span className="font-semibold" style={{ color: INK }}>{x.opp}</span>
          <span>({x.home ? "H" : "A"}){x.ko ? ` · ${koShort(x.ko)}` : ""}</span>
          <DiffPill d={x.diff} />
        </span>
      ))}
    </div>
  );
}

function PlayerCard({ p, mine, selected, usedGw, clubBlock, onPick }) {
  const used = (usedGw !== undefined || clubBlock) && !mine;
  return (
    <button onClick={() => onPick(p.id)} disabled={used}
      className={"text-left rounded-xl border px-3 py-2.5 transition-all " + (used ? "opacity-50 cursor-not-allowed bg-slate-50" : "bg-white hover:-translate-y-px hover:shadow-md")}
      style={selected ? { borderColor: VOLT, borderWidth: 2, background: "rgba(217,246,59,0.22)" } : mine ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0"><span className="font-semibold truncate">{p.name}</span><AvailChip p={p} /></div>
        <div className="shrink-0">
          {selected ? <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: DEEP, color: VOLT }}>SELECTED</span> : mine ? <Check size={16} style={{ color: BLUE }} /> : used ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: MUTED }}><Lock size={12} /> {usedGw !== undefined ? "GW" + usedGw : "Club picked"}</span>
          ) : (
            <div className="flex gap-0.5">{Array.from({ length: 5 }, (_, i) => <span key={i} className="w-1 h-3 rounded-sm" style={{ background: i < p.rating ? BLUE : "#DCE3EE" }} />)}</div>
          )}
        </div>
      </div>
    </button>
  );
}

function TeamRow({ team, players, open, onToggle, fixtures, curIds, sel, usedIds, gwUsed, clubBlocked, onPick }) {
  const usedCount = players.filter((p) => usedIds.has(p.id) && !curIds.has(p.id)).length;
  const hasMine = players.some((p) => curIds.has(p.id));
  const groups = POS_ORDER.map((pos) => [pos, players.filter((p) => p.pos === pos)]).filter(([, l]) => l.length);
  return (
    <div className="rounded-2xl bg-white overflow-hidden border" style={{ borderColor: hasMine ? BLUE : LINE, borderWidth: hasMine ? 2 : 1, boxShadow: open ? SHADOW : undefined }}>
      <button onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 transition-colors">
        <Crest team={team} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">{team}</span>
            {hasMine && <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md text-white" style={{ background: BLUE }}>Your pick{players.filter((p) => curIds.has(p.id)).length > 1 ? "s" : ""}</span>}
          </div>
          <FixtureLine fixtures={fixtures} />
        </div>
        <div className="text-right text-xs shrink-0" style={{ color: MUTED }}>
          <div className="font-semibold" style={{ color: INK }}>{players.length} {players.length === 1 ? "player" : "players"}</div>
          {usedCount > 0 && <div>{usedCount} used</div>}
        </div>
        <ChevronRight size={18} className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")} style={{ color: MUTED }} />
      </button>
      {open && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4" style={{ borderColor: LINE }}>
          {groups.map(([pos, list]) => (
            <div key={pos}>
              <div className="flex items-center gap-2 mb-2"><PosChip pos={pos} /><span className="text-xs font-semibold" style={{ color: MUTED }}>{POS_LABEL[pos]} · {list.length}</span></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {list.map((p) => <PlayerCard key={p.id} p={p} mine={curIds.has(p.id)} selected={sel === p.id} usedGw={gwUsed[p.id]} clubBlock={clubBlocked(p)} onPick={onPick} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const BD_NAMES = { "Goals": ["goal", "goals"], "Assists": ["assist", "assists"], "Clean sheet": ["clean sheet", "clean sheet"], "Saves": ["save", "saves"], "Bonus points": ["bonus", "bonus"], "Penalties saved": ["pen save", "pen saves"], "Defensive contribution": ["def. bonus", "def. bonus"] };
function whatScored(bd) {
  return (bd || []).filter((b) => b.points > 0 && b.label !== "Minutes played" && b.label !== "Other")
    .sort((a, b) => b.points - a.points).slice(0, 3)
    .map((b) => { const n = BD_NAMES[b.label] || [b.label.toLowerCase(), b.label.toLowerCase()]; return b.value > 1 ? b.value + " " + n[1] : n[0]; }).join(", ");
}

function TopPicks({ fixByTeam, curIds, sel, usedIds, clubBlocked = () => false, onPick, closed, lastGW }) {
  const [userBy, setBy] = useState(null);   // null = choose automatically
  const [lw, setLw] = useState(null);       // null = loading, [] = nothing to show
  const [more, setMore] = useState(false);  // false = top 5, true = top 10
  useEffect(() => {
    if (!lastGW) { setLw([]); return; }
    let off = false;
    api.loadGwPoints(lastGW).then((r) => { if (!off) setLw(r); }).catch(() => { if (!off) setLw([]); });
    return () => { off = true; };
  }, [lastGW]);
  const hasSeason = useMemo(() => PL_POOL.some((p) => p.pts > 0), [PL_POOL.length]);
  const hasLast = !!lw && lw.some((r) => r.points > 0 && BY_ID[r.player_id]);
  const by = userBy && (userBy === "last" ? hasLast : hasSeason) ? userBy : hasLast ? "last" : "pts";
  const lists = useMemo(() => POS_ORDER.map((pos) => {
    if (by === "last") {
      const l = (lw || []).filter((r) => BY_ID[r.player_id] && BY_ID[r.player_id].pos === pos)
        .sort((a, b) => b.points - a.points || BY_ID[a.player_id].name.localeCompare(BY_ID[b.player_id].name)).slice(0, 10)
        .map((r) => ({ p: BY_ID[r.player_id], stat: r.points, note: whatScored(r.breakdown) }));
      return [pos, l];
    }
    const l = PL_POOL.filter((p) => p.pos === pos && (fixByTeam[p.team] || []).length && (!clubBlocked(p) || curIds.has(p.id)) && (!usedIds.has(p.id) || curIds.has(p.id)))
      .sort((a, b) => b[by] - a[by] || b.pts - a.pts || a.name.localeCompare(b.name)).slice(0, 10)
      .map((p) => ({ p, stat: by === "pts" ? p.pts : p.form.toFixed(1), note: null }));
    return [pos, l];
  }), [by, lw, fixByTeam, usedIds, curIds, clubBlocked, PL_POOL.length]);
  if (!hasSeason && !hasLast) return null;
  const tab = (k, label) => <button key={k} onClick={() => setBy(k)} className={"px-3 py-1 rounded-full text-xs font-semibold border transition-colors " + (by === k ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={by === k ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-2">
        <div><div className="font-bold">{by === "last" ? "Top scorers last week" : "Top players by position"}</div>
          <div className="text-xs" style={{ color: MUTED }}>{by === "last" ? "Best scores in gameweek " + lastGW + ". Greyed out means already used, or no game this week." : "Players you haven't used yet, who play this gameweek"}</div></div>
        <div className="flex gap-1.5">{hasLast && tab("last", "Last week")}{hasSeason && tab("pts", "Season points")}{hasSeason && tab("form", "Form")}</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {lists.map(([pos, list]) => (
          <div key={pos} className="rounded-2xl bg-white border p-3" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <div className="flex items-center gap-2 mb-2"><PosChip pos={pos} /><span className="text-xs font-semibold" style={{ color: MUTED }}>{POS_LABEL[pos]}</span></div>
            <div className="space-y-1">
              {list.length === 0 && <div className="text-xs py-2" style={{ color: MUTED }}>No one available</div>}
              {list.slice(0, more ? 10 : 5).map(({ p, stat, note }, i) => {
                const fx = (fixByTeam[p.team] || []).map((f) => f.opp + (f.home ? " (H)" : " (A)")).join(", ");
                const isSel = sel === p.id, mine = curIds.has(p.id);
                const used = (usedIds.has(p.id) || clubBlocked(p)) && !mine, noGame = !fx;
                const off = by === "last" && (used || noGame);
                return (
                  <button key={p.id} onClick={() => onPick(p.id)} disabled={closed || off} title={off ? (used ? (usedIds.has(p.id) ? "Already used" : "You already have a player from this club") : "No game this week") : undefined}
                    className={"w-full flex items-center gap-2 text-left rounded-xl px-2 py-1.5 border transition-colors disabled:cursor-not-allowed " + (off ? "opacity-50" : "hover:bg-black/5")}
                    style={isSel ? { borderColor: VOLT, borderWidth: 2, background: "rgba(217,246,59,0.22)" } : mine ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: "transparent" }}>
                    <span className="w-4 text-xs font-bold tabular-nums" style={{ color: MUTED }}>{i + 1}</span>
                    <Crest team={p.team} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-sm font-semibold"><span className="truncate">{p.name}</span><AvailChip p={p} />{off && used && <Lock size={11} className="shrink-0" style={{ color: MUTED }} />}</span>
                      <span className="block text-[11px] truncate" style={{ color: MUTED }}>{by === "last" ? (off ? (used ? (usedIds.has(p.id) ? "Used already" : "Club already picked") : "No game this week") : note || "v " + fx) : "v " + fx}</span>
                    </span>
                    <span className="text-right shrink-0"><span className="block text-sm font-extrabold tabular-nums" style={{ color: BLUE }}>{stat}</span><span className="block text-[10px]" style={{ color: MUTED }}>{by === "form" ? "form" : "pts"}</span></span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {lists.some(([, l]) => l.length > 5) && (
        <div className="flex justify-center mt-3">
          <button onClick={() => setMore(!more)} className="px-4 py-1.5 rounded-full text-sm font-semibold border bg-white hover:bg-black/5 transition-colors flex items-center gap-1.5" style={{ borderColor: LINE, color: BLUE }}>
            {more ? "Show less" : "Show more"} <ChevronDown size={14} className={"transition-transform " + (more ? "rotate-180" : "")} />
          </button>
        </div>
      )}
    </div>
  );
}

function PickView({ currentGW, ctxs, closed, now, news, onNews }) {
  const [ctxId, setCtxId] = useState(null);
  const c = ctxs.find((x) => x.id === ctxId) || ctxs[0];
  const { usedIds, curIds, roundPicks, onPick, bySlot } = c;
  const [q, setQ] = useState(""); const [posFilter, setPosFilter] = useState("ALL"); const [teamFilter, setTeamFilter] = useState("ALL");
  const [open, setOpen] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  useEffect(() => { setSel(null); }, [currentGW, c.id]);
  const choose = (id) => { if (closed) return; setSel((cur) => (cur === id || curIds.has(id) ? null : id)); };
  const confirmPick = () => { if (sel) { onPick(sel); setSel(null); } };

  const gwUsed = useMemo(() => { const m = {}; Object.entries(roundPicks).forEach(([gw, ids]) => ids.forEach((id) => { m[id] = Number(gw); })); return m; }, [roundPicks]);
  const gwFixtures = useMemo(() => FIXTURES.filter((f) => f[0] === currentGW), [currentGW]);
  const fixByTeam = useMemo(() => {
    const m = {};
    gwFixtures.forEach(([, h, a, ko, hd, ad]) => {
      const hn = TEAM_BY_SHORT[h], an = TEAM_BY_SHORT[a];
      (m[hn] = m[hn] || []).push({ opp: a, home: true, ko, diff: hd });
      (m[an] = m[an] || []).push({ opp: h, home: false, ko, diff: ad });
    });
    return m;
  }, [gwFixtures]);

  const byTeam = useMemo(() => {
    const s = q.trim().toLowerCase(); const m = {};
    PL_POOL.forEach((p) => {
      if (posFilter !== "ALL" && p.pos !== posFilter) return;
      if (teamFilter !== "ALL" && p.team !== teamFilter) return;
      if (s && !`${p.name} ${p.team}`.toLowerCase().includes(s)) return;
      (m[p.team] = m[p.team] || []).push(p);
    });
    return m;
  }, [q, posFilter, teamFilter]);
  const teamsShown = TEAM_LIST.filter((t) => byTeam[t] && byTeam[t].length);
  const totalShown = teamsShown.reduce((n, t) => n + byTeam[t].length, 0);

  // searching or choosing a club opens the matching clubs; clearing them folds everything away again
  useEffect(() => {
    const s = q.trim().toLowerCase();
    if (s) setOpen(new Set(PL_POOL.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(s)).map((p) => p.team)));
    else if (teamFilter !== "ALL") setOpen(new Set([teamFilter]));
    else setOpen(new Set());
  }, [q, teamFilter]);

  const toggle = (team) => setOpen((prev) => { const n = new Set(prev); if (n.has(team)) n.delete(team); else n.add(team); return n; });
  const pickedList = [...curIds].map((id) => BY_ID[id]).filter(Boolean);
  const picked = !bySlot && pickedList.length ? pickedList[0] : null;
  const slotPick = (pos) => pickedList.find((x) => x.pos === pos);
  // in a four-pick game a club can only appear once per gameweek (the player you'd be replacing in the same slot doesn't count)
  const clubBlocked = (p) => !!bySlot && pickedList.some((x) => x.team === p.team && x.pos !== p.pos);
  const selPlayer = sel ? BY_ID[sel] : null;
  const replacing = selPlayer ? (bySlot ? slotPick(selPlayer.pos) : pickedList[0]) : null;
  const jumpTo = (pos) => { setPosFilter(pos); setTimeout(() => { const el = document.getElementById("player-list"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 50); };
  // once the big header scrolls out of view, a slim bar with this week's picks stays pinned under the site header
  const heroRef = useRef(null);
  const [heroSeen, setHeroSeen] = useState(true);
  const [hdrH, setHdrH] = useState(108);
  useEffect(() => {
    const el = heroRef.current; if (!el || typeof IntersectionObserver === "undefined") return;
    const hh = () => { const h = document.querySelector("header"); return h ? Math.round(h.getBoundingClientRect().height) : 108; };
    setHdrH(hh());
    const io = new IntersectionObserver(([e]) => setHeroSeen(e.isIntersecting), { rootMargin: "-" + hh() + "px 0px 0px 0px" });
    io.observe(el);
    const onResize = () => setHdrH(hh()); window.addEventListener("resize", onResize);
    return () => { io.disconnect(); window.removeEventListener("resize", onResize); };
  }, [c.id]);
  const pct = Math.min(100, Math.round((c.progress.used / c.progress.total) * 100));
  const field = "px-3 py-2.5 rounded-xl bg-white border text-sm focus:outline-none focus:ring-2";
  return (
    <div>
      {ctxs.length > 1 && (
        <div className="mb-3">
          <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Picking for</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {ctxs.map((x) => <button key={x.id} onClick={() => setCtxId(x.id)} className={"shrink-0 text-left rounded-xl border px-3 py-2 transition-colors " + (c.id === x.id ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
              style={c.id === x.id ? { background: DEEP } : { borderColor: LINE }}>
              <div className="text-sm font-bold">{x.label}</div>
              <div className="text-[11px]" style={{ color: c.id === x.id ? "rgba(255,255,255,0.7)" : MUTED }}>{x.sub}</div></button>)}
          </div>
        </div>
      )}
      <div ref={heroRef} className="relative overflow-hidden rounded-2xl p-5 sm:p-6 mb-5 text-white" style={{ background: "linear-gradient(135deg,#0A2342,#1B4F8F)", boxShadow: SHADOW }}>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.7)" }}>GAMEWEEK {currentGW}{c.id !== "main" || ctxs.length > 1 ? " · " + c.label.toUpperCase() : ""}</div>
            <div className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.8)" }}>{closed ? "Picks are closed for this gameweek." : <>Deadline {koDay(deadlineOf(currentGW))}, {koTime(deadlineOf(currentGW))} · <span className="font-semibold" style={{ color: VOLT }}>{untilDeadline(currentGW, now)}</span></>}</div>
            {bySlot ? (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {["GK", "DEF", "MID", "FWD"].map((pos) => {
                  const sp = slotPick(pos);
                  return (
                    <div key={pos} className="rounded-xl px-3 py-2.5 min-w-0 sm:w-40" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.14)" }}>
                      <div className="flex items-center justify-between mb-1"><PosChip pos={pos} />{sp && (closed ? <Lock size={13} style={{ color: VOLT }} /> : <Check size={14} style={{ color: VOLT }} />)}</div>
                      {sp ? (
                        <>
                          <div className="font-extrabold truncate">{sp.name}</div>
                          <div className="text-[11px] truncate" style={{ color: "rgba(255,255,255,0.7)" }}>{sp.team}</div>
                          {!closed && <button onClick={() => onPick(sp.id)} className="mt-1 text-[11px] font-semibold underline underline-offset-2 hover:text-white" style={{ color: "rgba(255,255,255,0.7)" }}>Clear</button>}
                        </>
                      ) : (
                        <button onClick={() => !closed && jumpTo(pos)} disabled={closed} className="text-left w-full">
                          <div className="font-bold text-sm" style={{ color: closed ? "rgba(255,255,255,0.55)" : VOLT }}>{closed ? "Not picked" : "Pick a " + POS_ONE[pos]}</div>
                          <div className="text-[11px]" style={{ color: "rgba(255,255,255,0.6)" }}>{closed ? "Scores 0" : "Tap to choose"}</div>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : picked ? (
              <div className="mt-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-3xl" style={HEAD}>{picked.name}</span>
                  <PosChip pos={picked.pos} />
                </div>
                <div className="flex items-center gap-2 mt-1 text-sm flex-wrap" style={{ color: "rgba(255,255,255,0.8)" }}>
                  <span className="inline-flex items-center gap-1.5 bg-white rounded-full pl-1 pr-2.5 py-0.5" style={{ color: INK }}><Crest team={picked.team} size={20} /><span className="font-semibold">{picked.team}</span></span>
                  <span className="inline-flex items-center gap-1 font-semibold" style={{ color: VOLT }}>{closed ? <Lock size={13} /> : <Check size={13} />} {closed ? lineFor(LOCKED_LINES, currentGW) : "Picked. Change it any time before the deadline."}</span>
                  <button onClick={() => onPick(picked.id)} className="text-xs font-semibold underline underline-offset-2 hover:text-white" style={{ color: "rgba(255,255,255,0.7)" }}>Clear pick</button>
                </div>
              </div>
            ) : (
              <div className="mt-1 text-2xl" style={HEAD}>{lineFor(NO_PICK_LINES, currentGW)}</div>
            )}
          </div>
          <div className="w-full sm:w-56">
            <div className="flex justify-between text-xs mb-1.5" style={{ color: "rgba(255,255,255,0.75)" }}>
              <span>{c.progress.label}</span><span className="font-semibold text-white tabular-nums">{c.progress.used} / {c.progress.total}</span>
            </div>
            <div className="h-2 rounded-full" style={{ background: "rgba(255,255,255,0.18)" }}>
              <div className="h-2 rounded-full transition-all" style={{ width: pct + "%", background: VOLT }} />
            </div>
          </div>
        </div>
      </div>

      <div className="sticky z-10 h-0" style={{ top: hdrH + 8 }}>
        <div aria-hidden={heroSeen} className={"absolute inset-x-0 top-0 rounded-xl text-white px-2.5 py-2 transition-all duration-200 " + (heroSeen ? "opacity-0 -translate-y-2 pointer-events-none" : "opacity-100")} style={{ background: DEEP, boxShadow: "0 8px 24px rgba(10,35,66,0.35)" }}>
          <div className={"grid gap-1.5 " + (bySlot ? "grid-cols-4" : "grid-cols-1")}>
            {(bySlot ? ["GK", "DEF", "MID", "FWD"] : [null]).map((pos) => {
              const sp = bySlot ? slotPick(pos) : picked;
              return (
                <div key={pos || "one"} className="rounded-lg px-2 py-1.5 min-w-0" style={{ background: "rgba(255,255,255,0.1)" }}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    {pos && <PosChip pos={pos} />}
                    {sp ? <><span className="font-bold text-sm truncate">{sp.name}</span>{closed ? <Lock size={12} className="shrink-0" style={{ color: VOLT }} /> : <Check size={13} className="shrink-0" style={{ color: VOLT }} />}</>
                      : <button onClick={() => !closed && pos && jumpTo(pos)} disabled={closed || !pos} className="text-sm font-bold truncate text-left" style={{ color: closed ? "rgba(255,255,255,0.55)" : VOLT }}>{closed ? "Not picked" : pos ? "Pick" : "No pick yet"}</button>}
                  </div>
                  {sp && <div className="text-[10px] truncate hidden sm:block mt-0.5" style={{ color: "rgba(255,255,255,0.65)" }}>{sp.team}</div>}
                </div>);
            })}
          </div>
        </div>
      </div>

      <FitnessPanel fixByTeam={fixByTeam} pickedList={pickedList} />

      <TopPicks fixByTeam={fixByTeam} curIds={curIds} sel={sel} usedIds={usedIds} clubBlocked={clubBlocked} onPick={choose} closed={closed} lastGW={currentGW > 1 ? currentGW - 1 : 0} />

      <FixturesPanel gw={currentGW} fixtures={gwFixtures} />

      <TeamNewsPanel gw={currentGW} fixByTeam={fixByTeam} news={news} now={now} onAll={onNews} />

      <ScoringPanel />

      <div id="player-list" className="flex flex-wrap items-center gap-2 mb-4 scroll-mt-40">
        <div className="relative flex-1 min-w-52">
          <Search size={16} className="absolute left-3.5 top-3" style={{ color: MUTED }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players or clubs"
            className={field + " w-full pl-10"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
        </div>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className={field + " max-w-40"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} aria-label="Filter by club">
          <option value="ALL">All clubs</option>
          {TEAM_LIST.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex gap-1.5">
          {["ALL", "GK", "DEF", "MID", "FWD"].map((p) => <button key={p} onClick={() => setPosFilter(p)}
            className={"px-3.5 py-2 rounded-full text-sm font-semibold transition-colors border " + (posFilter === p ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
            style={posFilter === p ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{p}</button>)}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-xs" style={{ color: MUTED }}>{teamsShown.length} {teamsShown.length === 1 ? "club" : "clubs"} · {totalShown} {totalShown === 1 ? "player" : "players"}</div>
        <div className="flex items-center gap-1 text-xs font-semibold">
          <button onClick={() => setOpen(new Set(teamsShown))} className="px-2.5 py-1 rounded-lg hover:bg-black/5 transition-colors" style={{ color: BLUE }}>Expand all</button>
          <button onClick={() => setOpen(new Set())} className="px-2.5 py-1 rounded-lg hover:bg-black/5 transition-colors" style={{ color: MUTED }}>Collapse all</button>
        </div>
      </div>

      <div className="space-y-2.5">
        {teamsShown.length === 0 && <div className="rounded-2xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "#C5D0E0", color: MUTED }}>Nothing matches that search. Try a different name or clear the filters.</div>}
        {teamsShown.map((t) => (
          <TeamRow key={t} team={t} players={byTeam[t]} open={open.has(t)} onToggle={() => toggle(t)}
            fixtures={fixByTeam[t] || []} curIds={curIds} sel={sel} usedIds={usedIds} gwUsed={gwUsed} clubBlocked={clubBlocked} onPick={choose} />
        ))}
      </div>

      {sel && BY_ID[sel] && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3 sm:pb-5 pointer-events-none">
          <div className="max-w-3xl mx-auto pointer-events-auto flex items-center gap-3 rounded-2xl p-3 pl-4 text-white" style={{ background: DEEP, boxShadow: "0 12px 40px rgba(10,35,66,0.45)" }}>
            <Crest team={BY_ID[sel].team} size={34} />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.65)" }}>{replacing ? "CHANGE GW" + currentGW + (bySlot ? " " + BY_ID[sel].pos : "") + " PICK TO" : "GW" + currentGW + (bySlot ? " " + BY_ID[sel].pos : "") + " PICK"}</div>
              <div className="font-bold truncate">{BY_ID[sel].name} <span className="font-medium" style={{ color: "rgba(255,255,255,0.7)" }}>· {BY_ID[sel].team}</span></div>
            </div>
            <button onClick={() => setSel(null)} className="px-3 py-2 rounded-xl text-sm font-semibold hover:bg-white/10 transition-colors" style={{ color: "rgba(255,255,255,0.8)" }}>Cancel</button>
            <button onClick={confirmPick} className="px-4 py-2.5 rounded-xl text-sm font-extrabold hover:brightness-95 transition" style={{ background: VOLT, color: DEEP }}>Confirm pick</button>
          </div>
        </div>
      )}

    </div>
  );
}

function MyPicksView({ official, showSeason, seasonLabel, picks, lpicks, ...rest }) {
  const [w, setW] = useState(official ? "monthly" : "season");
  const showMonthly = official && w === "monthly";
  const ORDER = ["GK", "DEF", "MID", "FWD", "ANY"];
  const src = showMonthly
    ? Object.fromEntries(Object.entries(lpicks[official.id] || {}).map(([gw, sl]) => [gw, ORDER.filter((k) => sl[k]).map((k) => sl[k])]))
    : Object.fromEntries(Object.entries(picks).map(([gw, id]) => [gw, [id]]));
  const tab = (k, label) => <button onClick={() => setW(k)} className={"px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors " + (w === k ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={w === k ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  return (
    <div>
      {official && showSeason && <div className="flex gap-1.5 mb-4">{tab("monthly", "Main game")}{tab("season", seasonLabel)}</div>}
      <SeasonView key={w} picks={src} perGw={showMonthly && official.bySlot ? 4 : 1} title={official ? (showMonthly ? "Your picks" : "Your season picks") : undefined} {...rest} />
    </div>
  );
}

function SeasonView({ picks, perGw, currentGW, pts, now, joined, title }) {
  const [openGw, setOpenGw] = useState(null);
  const rows = []; const lastShown = Math.min(TOTAL_GWS, Math.max(currentGW + 2, ...Object.keys(picks).map(Number)));
  let total = 0;
  for (let gw = 1; gw <= lastShown; gw++) {
    const ids = picks[gw] || []; const players = ids.map((id) => ({ player: BY_ID[id], data: pts[id + "|" + gw] || null })).filter((x) => x.player);
    let status, p = null;
    if (isLocked(gw, now)) {
      if (players.length) { status = "scored"; p = players.reduce((n, x) => n + (x.data ? x.data.points : 0), 0); total += p; }
      else if (joined && new Date(deadlineOf(gw)).getTime() < joined) status = "before";
      else { status = "missed"; p = 0; }
    }
    else if (gw === currentGW) status = players.length ? "picked" : "open"; else status = players.length ? "picked" : "future";
    rows.push({ gw, players, status, pts: p });
  }
  const noteFor = (it) => it.label === "Minutes played" ? it.value + " mins" : it.value > 1 ? "× " + it.value : "";
  return (
    <div>
      <div className="flex items-end justify-between mb-4">
        <h2 className="text-2xl" style={HEAD}>{title || "Your season"}</h2>
        <div className="text-sm" style={{ color: MUTED }}>Total <span className="font-extrabold text-xl tabular-nums" style={{ color: BLUE }}>{total}</span> pts</div>
      </div>
      <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
        <div className="grid grid-cols-12 px-4 py-2.5 text-xs font-semibold border-b" style={{ borderColor: LINE, color: MUTED, background: "#F7F9FC" }}>
          <div className="col-span-2">GW</div><div className="col-span-7">Player</div><div className="col-span-3 text-right">Points</div>
        </div>
        {rows.map((r) => {
          const canOpen = r.status === "scored";
          const isOpen = canOpen && openGw === r.gw;
          return (
          <div key={r.gw} className="border-b last:border-0" style={{ borderColor: "#EEF2F8", background: r.gw === currentGW ? "rgba(31,78,156,0.05)" : undefined }}>
          <div className={"grid grid-cols-12 px-4 py-3 items-center " + (canOpen ? "cursor-pointer hover:bg-black/5 transition-colors" : "")}
            onClick={canOpen ? () => setOpenGw(isOpen ? null : r.gw) : undefined}
            role={canOpen ? "button" : undefined} aria-expanded={canOpen ? isOpen : undefined}>
            <div className="col-span-2 font-bold tabular-nums" style={{ color: MUTED }}>{r.gw}</div>
            <div className="col-span-7 min-w-0">
              {r.players.length ? <div className="space-y-1">{r.players.map(({ player, data }) => <div key={player.id} className="flex items-center gap-2 min-w-0">
                <Crest team={player.team} size={22} /><span className="font-semibold truncate">{player.name}</span>
                <PosChip pos={player.pos} />
                {perGw > 1 && r.status === "scored" ? <span className="text-xs font-bold tabular-nums ml-auto sm:ml-1" style={{ color: MUTED }}>{data ? data.points : 0}</span> : <span className="text-xs truncate hidden sm:inline" style={{ color: MUTED }}>{player.team}</span>}</div>)}</div>
                : <span className="text-sm" style={{ color: MUTED }}>{r.status === "before" ? "Before you joined" : r.status === "missed" ? "No pick made" : r.status === "open" ? "Pick open" : "—"}</span>}
            </div>
            <div className="col-span-3 text-right">
              {r.status === "scored" && <span className="inline-flex items-center gap-1.5"><span className="font-extrabold tabular-nums" style={{ color: BLUE }}>{r.pts}</span><ChevronDown size={14} className={"transition-transform " + (isOpen ? "rotate-180" : "")} style={{ color: MUTED }} /></span>}
              {r.status === "missed" && <span className="font-bold tabular-nums text-rose-600">0</span>}
              {r.status === "before" && <span className="text-xs" style={{ color: "#98A6BC" }}>—</span>}
              {r.status === "picked" && <span className="text-xs inline-flex items-center gap-1 font-semibold" style={{ color: BLUE }}><Check size={11} /> {perGw > 1 ? r.players.length + " of " + perGw : "Picked"}</span>}
              {r.status === "open" && <span className="text-xs" style={{ color: MUTED }}>Awaiting pick</span>}
              {r.status === "future" && <span className="text-xs" style={{ color: "#98A6BC" }}>Upcoming</span>}
            </div>
          </div>
          {isOpen && (
            <div className="px-4 pb-4 space-y-2">
              {r.players.map(({ player, data }) => {
                const items = data ? data.breakdown : []; const pp = data ? data.points : 0;
                return (
              <div key={player.id} className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: LINE }}>
                {r.players.length > 1 && <div className="flex items-center gap-2 px-3 py-2 text-sm font-bold border-b" style={{ borderColor: "#EEF2F8", background: "#F7F9FC" }}><PosChip pos={player.pos} />{player.name}</div>}
                {items.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: MUTED }}>{pp === 0 ? "Didn't play, or no points yet." : "Points update shortly."}</div>}
                {items.map((it, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-0" style={{ borderColor: "#EEF2F8" }}>
                    <span className="font-medium">{it.label}{noteFor(it) && <span className="ml-1.5 text-xs" style={{ color: MUTED }}>{noteFor(it)}</span>}</span>
                    <span className="font-bold tabular-nums" style={{ color: it.points < 0 ? "#E11D48" : BLUE }}>{it.points > 0 ? "+" : ""}{it.points}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 text-sm font-extrabold" style={{ background: "#F7F9FC" }}>
                  <span>{r.players.length > 1 ? player.name : "GW" + r.gw + " total"}{data && data.provisional ? <span className="ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(217,246,59,0.45)" }}>provisional</span> : null}</span>
                  <span className="tabular-nums" style={{ color: BLUE }}>{pp} pts</span>
                </div>
              </div>
                );
              })}
              {r.players.length > 1 && <div className="flex items-center justify-between px-3 text-sm font-extrabold"><span>GW{r.gw} total</span><span className="tabular-nums" style={{ color: BLUE }}>{r.pts} pts</span></div>}
            </div>
          )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Leagues: rounds can be the whole season, calendar months, or blocks of N gameweeks. ---- */
const BLOCK_SIZES = [2, 3, 4, 5, 6, 8, 10];
const formatLabel = (f) => !f || f.type === "season" ? "Whole season" : f.type === "monthly" ? "Monthly rounds" : f.n === 1 ? "Every gameweek (same player allowed)" : "Every " + f.n + " gameweeks";
function roundsFor(format) {
  const all = Array.from({ length: TOTAL_GWS }, (_, i) => i + 1);
  if (!format || format.type === "season") return [{ id: "season", label: "Season", gws: all }];
  if (format.type === "monthly") return MONTHS.map((m) => ({ id: m.key, label: m.short, long: m.label, gws: m.gws }));
  const n = format.n || 4; const out = [];
  for (let i = 0; i < all.length; i += n) { const g = all.slice(i, i + n); out.push({ id: "b" + i, label: g.length === 1 ? "GW" + g[0] : "GW" + g[0] + "–" + g[g.length - 1], long: "Gameweeks " + g[0] + " to " + g[g.length - 1], gws: g }); }
  return out;
}
// A "period" is one round of a league: four gameweeks in the main game, whatever length a league chose, or a single week.
const periodOf = (format, gw) => roundsFor(format).find((r) => r.gws.includes(gw)) || null;
const resetNote = (format) => !format || format.type === "season" ? "No repeats all season" : format.type === "monthly" ? "Players come back each month" : format.n === 1 ? "Same player allowed every week" : "Players come back every " + format.n + " gameweeks";
const roundState = (r, currentGW) => r.gws[r.gws.length - 1] < currentGW ? "done" : r.gws[0] <= currentGW ? "live" : "upcoming";

// rows: one per member per locked gameweek (from the database); members with nothing locked yet have a single empty row.
function LeagueBoard({ lg, rows, myId, currentGW, openPickIds }) {
  const rounds = useMemo(() => roundsFor(lg.format), [lg.format, MONTHS.length]);
  const live = rounds.find((r) => roundState(r, currentGW) === "live") || rounds[rounds.length - 1];
  const multi = rounds.length > 1;
  const [sel, setSel] = useState(live.id);
  const users = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      if (!m.has(r.user_id)) m.set(r.user_id, { id: r.user_id, name: r.username, gws: {} });
      if (r.gameweek_id != null) { const g = m.get(r.user_id).gws; const c = g[r.gameweek_id] || { names: [], pts: 0 }; c.names.push(r.player_name); c.pts += r.points || 0; g[r.gameweek_id] = c; }
    });
    return [...m.values()];
  }, [rows]);
  const pts = (u, gws) => gws.reduce((n, gw) => n + ((u.gws[gw] || {}).pts || 0), 0);
  const ALL = Array.from({ length: TOTAL_GWS }, (_, i) => i + 1);
  const wins = {};
  const winners = rounds.map((r) => {
    if (roundState(r, currentGW) !== "done") return null;
    const sc = users.map((u) => ({ u, p: pts(u, r.gws) })).sort((a, b) => b.p - a.p);
    if (!sc.length || sc[0].p === 0) return { r, none: true };
    const top = sc.filter((x) => x.p === sc[0].p);
    top.forEach((x) => { wins[x.u.id] = (wins[x.u.id] || 0) + 1; });
    return { r, top: top.map((x) => x.u.name), p: sc[0].p };
  }).filter(Boolean);
  const isOverall = sel === "overall";
  const round = rounds.find((r) => r.id === sel) || live;
  const gws = isOverall ? ALL : round.gws;
  const board = users.map((u) => ({ u, p: pts(u, gws), season: pts(u, ALL), wins: wins[u.id] || 0 })).sort((a, b) => b.p - a.p || a.u.name.localeCompare(b.u.name));
  const state = isOverall ? "live" : roundState(round, currentGW);
  const chip = (id, label, st) => (
    <button key={id} onClick={() => setSel(id)} className={"shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors " + (sel === id ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
      style={sel === id ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>
      {st === "live" && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style={{ background: sel === id ? VOLT : "#16A34A" }} />}{label}</button>
  );
  const pickLine = (u) => {
    if (u.id === myId) { const ps = (openPickIds || []).map((id) => BY_ID[id]).filter(Boolean); return `GW${currentGW}: ${ps.length ? ps.map((x) => x.name).join(", ") : "no picks yet"}`; }
    const last = Object.keys(u.gws).map(Number).sort((a, b) => b - a)[0];
    return last ? `GW${last}: ${u.gws[last].names.join(", ")}` : "No locked picks yet";
  };
  return (
    <div>
      {multi && <div className="flex gap-1.5 overflow-x-auto px-4 py-3 border-b" style={{ borderColor: LINE }}>
        {chip("overall", "Overall", "x")}
        {rounds.filter((r) => !(lg.format.type === "gws" && lg.format.n === 1) || roundState(r, currentGW) !== "upcoming").map((r) => chip(r.id, r.label, roundState(r, currentGW)))}
      </div>}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between text-xs" style={{ color: MUTED }}>
        <span className="font-semibold">{isOverall ? "Season standings" : round.long || "Full season"}</span>
        <span>{isOverall ? "Total points" : state === "done" ? "Period complete" : state === "live" ? "Period in progress" : "Starts GW" + round.gws[0]}</span>
      </div>
      {board.length === 0 && <div className="px-4 py-6 text-sm text-center" style={{ color: MUTED }}>No one here yet.</div>}
      {board.map((row, i) => {
        const leader = i === 0 && row.p > 0;
        return <div key={row.u.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0" style={{ borderColor: "#EEF2F8", background: row.u.id === myId ? "rgba(31,78,156,0.05)" : undefined }}>
          <div className="w-6 text-center font-extrabold tabular-nums" style={{ color: MUTED }}>{leader ? <Crown size={16} className="mx-auto" style={{ color: "#C9A400" }} /> : i + 1}</div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{row.u.name} {row.u.id === myId && <span className="text-xs font-normal" style={{ color: MUTED }}>(you)</span>}</div>
            <div className="text-xs truncate" style={{ color: MUTED }}>
              {isOverall && multi && row.wins > 0 ? row.wins + (row.wins === 1 ? " period win · " : " period wins · ") : !isOverall && multi ? "Season " + row.season + " · " : ""}
              {pickLine(row.u)}
            </div>
          </div>
          <div className="font-extrabold tabular-nums text-lg" style={{ color: BLUE }}>{row.p}</div>
        </div>;
      })}
      {multi && winners.length > 0 && (
        <div className="px-4 py-3 border-t" style={{ borderColor: LINE, background: "#F7F9FC" }}>
          <div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Period winners</div>
          <div className="flex flex-wrap gap-1.5">
            {winners.map((w) => <span key={w.r.id} className="text-xs rounded-full bg-white border px-2.5 py-1" style={{ borderColor: LINE }}>
              <span style={{ color: MUTED }}>{w.r.label}</span> <span className="font-bold">{w.none ? "no score" : w.top.join(" & ")}</span>{!w.none && <span className="tabular-nums" style={{ color: BLUE }}> {w.p}</span>}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function LeaguesView({ myId, leagues, official, tables, picks, lpicks, currentGW, onCreate, onJoin }) {
  const [name, setName] = useState(""); const [joinCode, setJoinCode] = useState(""); const [joinMsg, setJoinMsg] = useState(""); const [open, setOpen] = useState(null);
  const [reset, setReset] = useState(false); const [openMain, setOpenMain] = useState({ season: true, monthly: true }); const [fmt, setFmt] = useState("gws"); const [blockN, setBlockN] = useState(4);
  const [created, setCreated] = useState(null); const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false); const [createErr, setCreateErr] = useState("");
  const card = "rounded-2xl bg-white border p-5";
  const field = "w-full mb-2 px-3.5 py-2.5 rounded-xl bg-white border text-sm focus:outline-none focus:ring-2";
  const format = fmt === "season" ? { type: "season" } : fmt === "monthly" ? { type: "monthly" } : fmt === "weekly" ? { type: "gws", n: 1 } : { type: "gws", n: blockN };
  const nRounds = roundsFor(format).length;
  const create = async () => {
    if (!name.trim() || busy) return; setBusy(true); setCreateErr("");
    try { const code = await onCreate(name.trim(), format, resetOn && fmt !== "season"); setCreated({ name: name.trim(), code }); setName(""); }
    catch (e) { setCreateErr(friendlyError(e.message)); }
    setBusy(false);
  };
  const join = async () => { if (!joinCode.trim()) return; setJoinMsg((await onJoin(joinCode.trim())) || "Joined!"); };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const FMTS = [...(SEASON_GAME ? [["season", "Whole season", "One winner at the end"]] : []), ["gws", "Set number of gameweeks", "Pick the length of each period. A player can be used once per period."], ["weekly", "Every week", "Players come back every gameweek, so you can pick the same player each week."], ["monthly", "Calendar month", "A fresh start each month"]];
  const resetOn = SEASON_GAME ? reset : true;
  const mainRows = tables.main || [];
  const officialRows = official ? (tables[official.id] || []) : null;
  const mains = [{ id: "monthly", name: "Main game", sub: official ? resetNote(official.format).toLowerCase() + ", a winner each period" : "a winner each period, players come back", format: official ? official.format : { type: "gws", n: 4 }, rows: officialRows || mainRows, picks: official ? Object.values((lpicks[official.id] || {})[currentGW] || {}) : (picks[currentGW] ? [picks[currentGW]] : []) },
    ...(SEASON_GAME ? [{ id: "season", name: "OnePick Season", sub: "one table, all 38 gameweeks, no repeats", format: { type: "season" }, rows: mainRows, picks: picks[currentGW] ? [picks[currentGW]] : [] }] : [])];
  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <div className="lg:col-span-2 space-y-4">
        <div className={card} style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <h3 className="font-bold mb-1 flex items-center gap-2"><Plus size={16} style={{ color: BLUE }} /> Start a league</h3>
          <p className="text-xs mb-3" style={{ color: MUTED }}>You'll get a code to share with your mates.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="League name" maxLength={40}
            className={field} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          <div className="text-xs font-semibold mt-2 mb-1.5" style={{ color: MUTED }}>How long is each period?</div>
          <div className="grid gap-1.5 mb-2">
            {FMTS.map(([id, t, d]) => <button key={id} onClick={() => setFmt(id)} className="text-left rounded-xl border px-3 py-2 transition-colors hover:bg-black/5"
              style={fmt === id ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }}>
              <div className="text-sm font-semibold flex items-center justify-between">{t}{fmt === id && <Check size={14} style={{ color: BLUE }} />}</div>
              <div className="text-xs" style={{ color: MUTED }}>{d}</div></button>)}
          </div>
          {fmt === "gws" && <div className="flex items-center gap-2 mb-2 text-sm">
            <span style={{ color: MUTED }}>Each period is</span>
            <select value={blockN} onChange={(e) => setBlockN(Number(e.target.value))} className="px-2.5 py-1.5 rounded-lg bg-white border text-sm" style={{ borderColor: LINE }} aria-label="Gameweeks per period">
              {BLOCK_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <span style={{ color: MUTED }}>gameweeks</span></div>}
          {!SEASON_GAME && <div className="flex items-start gap-3 rounded-xl border px-3 py-2.5 mb-2" style={{ borderColor: LINE, background: "#F7F9FC" }}>
            <RotateCcw size={16} className="mt-0.5 shrink-0" style={{ color: BLUE }} />
            <span className="text-xs" style={{ color: MUTED }}><span className="block text-sm font-semibold" style={{ color: INK }}>{fmt === "weekly" ? "Players come back every week" : "Players come back every period"}</span>{fmt === "weekly" ? "Each league has its own picks, and you can pick the same player in as many weeks as you like." : "Each league has its own picks, and a player can be used once per period."}</span></div>}
          {SEASON_GAME && fmt !== "season" && <button onClick={() => setReset(!reset)} className="w-full text-left flex items-start gap-3 rounded-xl border px-3 py-2.5 mb-2 transition-colors hover:bg-black/5"
            style={reset ? { borderColor: BLUE, borderWidth: 2, background: "rgba(31,78,156,0.06)" } : { borderColor: LINE }} role="switch" aria-checked={reset}>
            <span className="mt-0.5 w-9 h-5 shrink-0 rounded-full relative transition-colors" style={{ background: reset ? BLUE : "#C5D0E0" }}>
              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: reset ? 18 : 2 }} /></span>
            <span><span className="block text-sm font-semibold">Reset OnePicks each round</span>
              <span className="block text-xs" style={{ color: MUTED }}>{reset ? "Players come back at the start of every round. Members make a separate pick for this league." : "Off: a player can only be used once all season, same as the main game."}</span></span>
          </button>}
          <div className="text-xs mb-3" style={{ color: MUTED }}>{formatLabel(format)}{fmt !== "season" && resetOn && fmt !== "weekly" ? " · picks reset" : ""} · {nRounds === 1 ? "one table, one winner" : fmt === "weekly" ? "a winner every gameweek plus an overall table" : nRounds + " periods, a winner for each plus an overall table"}</div>
          <button onClick={create} disabled={busy} className="w-full py-2.5 rounded-xl text-white font-bold hover:brightness-110 transition disabled:opacity-60" style={{ background: BLUE }}>{busy ? "Creating…" : "Create league"}</button>
          {createErr && <div className="text-sm mt-2 text-rose-600">{createErr}</div>}
          {created && <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "rgba(217,246,59,0.25)" }}>
            <div className="font-semibold">{created.name} is live.</div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span>Share code <span className="font-mono tracking-widest font-bold" style={{ color: BLUE }}>{created.code}</span></span>
              <button onClick={() => copy(created.code)} className="text-xs font-bold px-2.5 py-1 rounded-lg bg-white border hover:bg-black/5" style={{ borderColor: LINE }}>{copied ? "Copied" : "Copy code"}</button>
            </div></div>}
        </div>
        <div className={card} style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <h3 className="font-bold mb-3 flex items-center gap-2"><Users size={16} style={{ color: BLUE }} /> Join with a code</h3>
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && join()} placeholder="Enter code (e.g. K7P2M)"
            className={field + " tracking-widest"} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} />
          <button onClick={join} className="w-full py-2.5 rounded-xl font-semibold border hover:bg-black/5 transition-colors" style={{ borderColor: LINE }}>Join league</button>
          {joinMsg && <div className={"text-sm mt-2 " + (joinMsg === "Joined!" ? "text-emerald-600" : "text-rose-600")}>{joinMsg}</div>}
        </div>
      </div>
      <div className="lg:col-span-3 space-y-3">
        <h3 className="font-bold flex items-center gap-2"><Trophy size={16} style={{ color: BLUE }} /> {mains.length > 1 ? "Main leagues" : "Main league"}</h3>
        {mains.map((m) => (
          <div key={m.id} className="rounded-2xl overflow-hidden border" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <button onClick={() => setOpenMain({ ...openMain, [m.id]: !openMain[m.id] })} className="w-full px-4 py-3.5 text-white flex items-center justify-between gap-3 text-left" style={{ background: "linear-gradient(135deg,#0A2342,#1B4F8F)" }}>
              <div><div className="font-bold">{m.name}</div>
                <div className="text-xs" style={{ color: "rgba(255,255,255,0.75)" }}>Everyone's in · {new Set(m.rows.map((r) => r.user_id)).size} {new Set(m.rows.map((r) => r.user_id)).size === 1 ? "gaffer" : "gaffers"} · {m.sub}</div></div>
              <ChevronRight size={18} className={"shrink-0 transition-transform " + (openMain[m.id] ? "rotate-90" : "")} style={{ color: VOLT }} />
            </button>
            {openMain[m.id] && <div className="bg-white"><LeagueBoard lg={m} rows={m.rows} myId={myId} currentGW={currentGW} openPickIds={m.picks} /></div>}
          </div>
        ))}

        <h3 className="font-bold flex items-center gap-2 pt-3"><Users size={16} style={{ color: BLUE }} /> Your leagues</h3>
        {leagues.length === 0 && <div className="rounded-2xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "#C5D0E0", color: MUTED }}>No private leagues yet. Start one, or join a mate's with their code.</div>}
        {leagues.map((lg) => {
          const isOpen = open === lg.id;
          const usesOwn = lg.reset && lg.format.type !== "season";
          return <div key={lg.id} className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
            <button onClick={() => setOpen(isOpen ? null : lg.id)} className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-black/5 transition-colors">
              <div className="text-left"><div className="font-bold">{lg.name}</div>
                <div className="text-xs" style={{ color: MUTED }}>{lg.memberCount} {lg.memberCount === 1 ? "gaffer" : "gaffers"} · {formatLabel(lg.format)}{lg.reset ? " · picks reset" : ""} · code <span className="font-mono tracking-widest font-semibold" style={{ color: BLUE }}>{lg.code}</span></div></div>
              <ChevronRight size={18} className={"transition-transform " + (isOpen ? "rotate-90" : "")} style={{ color: MUTED }} />
            </button>
            {isOpen && <div className="border-t" style={{ borderColor: LINE }}>
              <LeagueBoard lg={lg} rows={tables[lg.id] || []} myId={myId} currentGW={currentGW} openPickIds={usesOwn ? Object.values((lpicks[lg.id] || {})[currentGW] || {}) : (picks[currentGW] ? [picks[currentGW]] : [])} /></div>}
          </div>;
        })}
      </div>
    </div>
  );
}

/* ---- Scoring: the exact points, by position. Values are the official FPL points the game is scored from. ---- */
const SCORING = [
  ["Playing", [
    ["Up to 60 minutes", [1, 1, 1, 1]],
    ["60 minutes or more", [2, 2, 2, 2]],
  ]],
  ["Attacking", [
    ["Goal", [10, 6, 5, 4]],
    ["Assist", [3, 3, 3, 3]],
  ]],
  ["Defending", [
    ["Clean sheet (60+ minutes)", [4, 4, 1, null]],
    ["Every 2 goals conceded", [-1, -1, null, null]],
    ["Every 3 saves", [1, null, null, null]],
    ["Penalty save", [5, null, null, null]],
    ["Defensive contribution *", [null, 2, 2, 2]],
  ]],
  ["Discipline", [
    ["Yellow card", [-1, -1, -1, -1]],
    ["Red card", [-3, -3, -3, -3]],
    ["Own goal", [-2, -2, -2, -2]],
    ["Penalty miss", [-2, -2, -2, -2]],
  ]],
  ["Bonus", [
    ["Best three players in a match **", ["1 to 3", "1 to 3", "1 to 3", "1 to 3"]],
  ]],
];
function ScoringTable() {
  const cols = { display: "grid", gridTemplateColumns: "minmax(0,1fr) repeat(4, 3rem)", alignItems: "center" };
  const cell = (v) => v == null ? <span style={{ color: "#B6C1D3" }}>–</span>
    : typeof v === "string" ? <span className="font-bold" style={{ color: BLUE }}>{v}</span>
    : v > 0 ? <span className="font-bold" style={{ color: BLUE }}>+{v}</span>
    : <span className="font-bold" style={{ color: "#E11D48" }}>{"−" + Math.abs(v)}</span>;
  return (
    <div>
      <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
        <div className="px-4 py-2.5 border-b" style={{ ...cols, borderColor: LINE, background: "#F7F9FC" }}>
          <div className="text-xs font-semibold" style={{ color: MUTED }}>Points for</div>
          {["GK", "DEF", "MID", "FWD"].map((p) => <div key={p} className="flex justify-center"><PosChip pos={p} /></div>)}
        </div>
        {SCORING.map(([group, rows]) => (
          <div key={group}>
            <div className="px-4 py-1.5 text-[11px] font-bold tracking-wide" style={{ background: "#F7F9FC", color: MUTED }}>{group.toUpperCase()}</div>
            {rows.map(([label, vals]) => (
              <div key={label} className="px-4 py-2 text-sm border-b last:border-0" style={{ ...cols, borderColor: "#EEF2F8" }}>
                <div className="pr-2">{label}</div>
                {vals.map((v, i) => <div key={i} className="text-center tabular-nums text-[13px]">{cell(v)}</div>)}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="text-xs mt-3 space-y-1" style={{ color: MUTED }}>
        <div>A clean sheet needs the player on the pitch for at least 60 minutes.</div>
        <div>* Defenders get +2 for 10 or more clearances, blocks, interceptions and tackles in a match. Midfielders and forwards get +2 for 12 or more of the same, plus ball recoveries.</div>
        <div>** The best three players in each match get 3, 2 and 1 bonus points.</div>
        <div>These are the official Fantasy Premier League points. They can change until about 9am the morning after a gameweek's last match.</div>
      </div>
    </div>
  );
}
function ScoringPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl bg-white border mb-5 overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-black/5 transition-colors">
        <span className="flex items-center gap-2 font-bold"><Info size={16} style={{ color: BLUE }} /> How points work</span>
        <span className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
          <span className="hidden sm:inline">Goal 4 to 10 · clean sheet up to 4 · assist 3</span>
          <ChevronRight size={18} className={"transition-transform " + (open ? "rotate-90" : "")} />
        </span>
      </button>
      {open && <div className="border-t p-4" style={{ borderColor: LINE }}><ScoringTable /></div>}
    </div>
  );
}

/* ---- Availability and fixture difficulty helpers ---- */
const DIFF_STYLE = { 1: ["#0E8A4F", "#FFFFFF"], 2: ["#8FD9A3", "#0B1B33"], 3: ["#E3E9F2", "#0B1B33"], 4: ["#F4A39B", "#0B1B33"], 5: ["#B3153B", "#FFFFFF"] };
const DIFF_WORD = { 1: "very easy", 2: "easy", 3: "average", 4: "hard", 5: "very hard" };
const DIFF_FACTOR = { 1: 1.2, 2: 1.1, 3: 1, 4: 0.9, 5: 0.8 };
function DiffPill({ d, wide }) {
  if (d == null) return null;
  const [bg, fg] = DIFF_STYLE[d] || DIFF_STYLE[3];
  return <span title={"Fixture difficulty " + d + " of 5 (" + (DIFF_WORD[d] || "") + ")"} className={"inline-flex items-center justify-center rounded text-[10px] font-extrabold tabular-nums leading-none py-0.5 " + (wide ? "px-2" : "px-1.5")} style={{ background: bg, color: fg }}>{d}</span>;
}
const AVAIL = { d: ["Doubtful", "bg-amber-100 text-amber-800"], i: ["Injured", "bg-rose-100 text-rose-800"], s: ["Suspended", "bg-rose-100 text-rose-800"], u: ["Unavailable", "bg-slate-200 text-slate-700"], n: ["Unavailable", "bg-slate-200 text-slate-700"] };
function availLabel(p) {
  if (!p || p.status === "a" || !AVAIL[p.status]) return null;
  const pct = p.chance != null && p.chance < 100 && p.chance > 0 ? " " + p.chance + "%" : "";
  return AVAIL[p.status][0] + pct;
}
function AvailChip({ p }) {
  const l = availLabel(p);
  if (!l) return null;
  return <span title={p.news || l} className={"text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 " + AVAIL[p.status][1]}>{l}</span>;
}
/* rough points estimate for one player in one gameweek: recent form, per game, nudged by fixture difficulty,
   and scaled by the chance of playing when it is the very next gameweek */
function estimateFor(p, list, isNext) {
  let t = 0; list.forEach((f) => { t += p.form * (DIFF_FACTOR[f.diff] || 1); });
  if (isNext) { if (p.chance != null) t *= p.chance / 100; else if (p.status === "s" || p.status === "u" || p.status === "n") t = 0; }
  return t;
}
let TEAM_FIX = null;   // team name -> gameweek -> [{opp, home, diff, ko}], rebuilt after each data load
function getTeamFixtures() {
  if (TEAM_FIX) return TEAM_FIX;
  const m = {};
  const add = (t, gw, o) => { const byGw = (m[t] = m[t] || {}); (byGw[gw] = byGw[gw] || []).push(o); };
  FIXTURES.forEach(([gw, h, a, ko, hd, ad]) => { add(TEAM_BY_SHORT[h], gw, { opp: a, home: true, diff: hd, ko }); add(TEAM_BY_SHORT[a], gw, { opp: h, home: false, diff: ad, ko }); });
  return (TEAM_FIX = m);
}
const ago = (iso, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60000));
  return m < 60 ? Math.max(1, m) + "m ago" : m < 2880 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";
};
function FxInline({ list }) {
  if (!list || !list.length) return <span>No game this week</span>;
  return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">{list.map((f, i) => <span key={i} className="inline-flex items-center gap-1">{f.home ? "v" : "@"} {f.opp} ({f.home ? "H" : "A"}) <DiffPill d={f.diff} /></span>)}</span>;
}
const KIND = { injury: ["Injury", "bg-rose-100 text-rose-800"], lineup: ["Line-up", "bg-sky-100 text-sky-800"] };

function NewsItem({ n, now }) {
  const k = KIND[n.kind] || ["News", "bg-slate-100 text-slate-700"];
  const clubs = (n.team_ids || []).map((id) => TEAM_NAME[id]).filter(Boolean);
  const named = (n.player_ids || []).map((id) => BY_ID[id]).filter(Boolean);
  return (
    <a href={n.url} target="_blank" rel="noopener noreferrer" className="block rounded-xl border bg-white px-3.5 py-3 hover:bg-black/5 transition-colors" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className={"text-[10px] font-bold px-1.5 py-0.5 rounded " + k[1]}>{k[0]}</span>
        {clubs.slice(0, 3).map((c) => <span key={c} className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: MUTED }}><Crest team={c} size={14} />{c}</span>)}
        <span className="text-[11px] ml-auto" style={{ color: MUTED }}>{n.source} · {ago(n.published_at, now)}</span>
      </div>
      <div className="text-sm font-semibold leading-snug">{n.title} <ExternalLink size={12} className="inline align-baseline" style={{ color: MUTED }} /></div>
      {n.summary && <div className="text-xs mt-1 line-clamp-2" style={{ color: MUTED }}>{n.summary}</div>}
      {named.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{named.slice(0, 4).map((p) => <span key={p.id} className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(31,78,156,0.08)", color: BLUE }}>{p.name}</span>)}</div>}
    </a>
  );
}

/* Pick screen: what's happening at the clubs playing this gameweek */
function FitnessPanel({ fixByTeam, pickedList }) {
  const [all, setAll] = useState(false);
  const playing = useMemo(() => new Set(Object.keys(fixByTeam)), [fixByTeam]);
  const flagged = pickedList.filter((p) => availLabel(p));
  const key = useMemo(() => PL_POOL.filter((p) => playing.has(p.team) && ["d", "i", "s"].includes(p.status) && p.news && p.rating >= 4)
    .sort((a, b) => String(b.newsAdded || "").localeCompare(String(a.newsAdded || "")) || b.rating - a.rating).slice(0, 8), [playing]);
  if (!flagged.length && !key.length) return null;
  const shown = all ? key : key.slice(0, 4);
  return (
    <div className="rounded-2xl bg-white border mb-5 px-4 py-3.5 space-y-3" style={{ borderColor: LINE, boxShadow: SHADOW }}>
      {flagged.length > 0 && <div className="rounded-xl px-3 py-2.5 bg-amber-50 border border-amber-200">
        <div className="text-xs font-bold text-amber-900 mb-1 flex items-center gap-1.5"><AlertTriangle size={13} /> Check your picks</div>
        {flagged.map((p) => <div key={p.id} className="text-sm"><span className="font-semibold">{p.name}</span> <AvailChip p={p} /> <span className="text-xs" style={{ color: MUTED }}>{p.news}</span></div>)}
      </div>}
      {key.length > 0 && <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-xs font-semibold" style={{ color: MUTED }}>Key players with fitness news</div>
          {key.length > 4 && <button onClick={() => setAll(!all)} className="text-xs font-semibold" style={{ color: BLUE }}>{all ? "Show fewer" : "Show " + (key.length - 4) + " more"}</button>}
        </div>
        <div className="grid sm:grid-cols-2 gap-1.5">{shown.map((p) => <div key={p.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: "#EEF2F8" }}>
          <Crest team={p.team} size={20} /><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 text-sm font-semibold"><span className="truncate">{p.name}</span><PosChip pos={p.pos} /><AvailChip p={p} /></div><div className="text-[11px] truncate" style={{ color: MUTED }} title={p.news}>{p.news}</div></div></div>)}</div>
      </div>}
    </div>
  );
}

function TeamNewsPanel({ gw, fixByTeam, news, now, onAll }) {
  const [open, setOpen] = useState(true);
  const [more, setMore] = useState(false);
  const playing = useMemo(() => new Set(Object.keys(fixByTeam)), [fixByTeam]);
  const items = (news || []).filter((n) => (n.team_ids || []).some((id) => playing.has(TEAM_NAME[id]))).slice(0, 8);
  if (!items.length) return null;
  const shown = more ? items : items.slice(0, 2);
  return (
    <div className="rounded-2xl bg-white border mb-5" style={{ borderColor: LINE, boxShadow: SHADOW }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2 font-bold"><Newspaper size={16} style={{ color: BLUE }} /> Team news for gameweek {gw}</span>
        <span className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>Latest headlines<ChevronRight size={16} className={"transition-transform " + (open ? "rotate-90" : "")} /></span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t space-y-2" style={{ borderColor: LINE }}>
          <div className="space-y-1.5">{shown.map((n) => <NewsItem key={n.id} n={n} now={now} />)}</div>
          <div className="flex items-center gap-4">
            {items.length > 2 && <button onClick={() => setMore(!more)} className="text-sm font-semibold" style={{ color: BLUE }}>{more ? "Show fewer headlines" : "Show " + (items.length - 2) + " more headlines"}</button>}
            <button onClick={onAll} className="text-sm font-semibold" style={{ color: BLUE }}>See all team news →</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Fixtures tab: how hard is each club's run? ---- */
function FixturesView({ currentGW }) {
  const [n, setN] = useState(4); const [sort, setSort] = useState("easy");
  const gws = GAMEWEEKS.filter((g) => g.id >= currentGW && g.id < currentGW + n).map((g) => g.id);
  const tf = getTeamFixtures();
  const hasDiff = FIXTURES.some((f) => f[4] != null);
  const rows = useMemo(() => {
    const r = TEAM_LIST.map((team) => {
      const cells = gws.map((gw) => (tf[team] || {})[gw] || []); const flat = cells.flat(); const rated = flat.filter((f) => f.diff != null);
      return { team, cells, games: flat.length, avg: rated.length ? rated.reduce((s, f) => s + f.diff, 0) / rated.length : null };
    });
    const cmp = sort === "az" ? (a, b) => a.team.localeCompare(b.team)
      : (a, b) => ((a.avg ?? 99) - (b.avg ?? 99)) * (sort === "hard" ? -1 : 1) || b.games - a.games || a.team.localeCompare(b.team);
    return r.sort(cmp);
  }, [n, sort, currentGW, hasDiff]);
  const rated = rows.filter((r) => r.avg != null).sort((a, b) => a.avg - b.avg);
  const chip = (v, cur, set, label) => <button key={v} onClick={() => set(v)} className={"px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors " + (cur === v ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={cur === v ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  const avgStyle = (a) => DIFF_STYLE[Math.min(5, Math.max(1, Math.round(a)))];
  return (
    <div>
      <h2 className="text-3xl mb-1" style={HEAD}>Fixture difficulty</h2>
      <p className="text-sm mb-4 max-w-2xl" style={{ color: MUTED }}>How tough is each club's run? Ratings are the official Fantasy Premier League difficulty scores, from 1 (easiest) to 5 (hardest). Good for finding clean sheets and goals.</p>
      {!hasDiff && <div className="mb-4 rounded-xl px-3.5 py-2.5 text-sm bg-amber-50 border border-amber-200 text-amber-900">Difficulty ratings aren't loaded yet. They arrive after the next nightly update.</div>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1.5">{[4, 6, 8].map((v) => chip(v, n, setN, "Next " + v))}</div>
        <div className="flex-1" />
        <div className="flex gap-1.5 items-center"><span className="text-xs font-semibold" style={{ color: MUTED }}>Sort</span>{chip("easy", sort, setSort, "Easiest first")}{chip("hard", sort, setSort, "Hardest first")}{chip("az", sort, setSort, "A to Z")}</div>
      </div>
      {hasDiff && rated.length > 5 && <div className="mb-3 text-sm rounded-xl border bg-white px-3.5 py-2.5" style={{ borderColor: LINE }}>
        <span className="font-semibold">Easiest runs:</span> {rated.slice(0, 3).map((r) => r.team + " (" + r.avg.toFixed(1) + ")").join(", ")}. <span className="font-semibold ml-1">Toughest:</span> {rated.slice(-3).reverse().map((r) => r.team + " (" + r.avg.toFixed(1) + ")").join(", ")}.
      </div>}
      <div className="rounded-2xl bg-white border overflow-x-auto" style={{ borderColor: LINE, boxShadow: SHADOW }}>
        <table className="w-full text-sm border-separate" style={{ borderSpacing: 0, minWidth: 80 + gws.length * 84 + 70 }}>
          <thead><tr className="text-xs" style={{ color: MUTED }}>
            <th className="sticky left-0 z-10 bg-[#F7F9FC] text-left font-semibold px-3 py-2.5 border-b" style={{ borderColor: LINE }}>Club</th>
            {gws.map((gw) => <th key={gw} className="font-semibold px-1 py-2.5 border-b bg-[#F7F9FC]" style={{ borderColor: LINE }}>GW{gw}</th>)}
            <th className="font-semibold px-2 py-2.5 border-b bg-[#F7F9FC]" style={{ borderColor: LINE }}>Avg</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team}>
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 border-b" style={{ borderColor: "#EEF2F8" }}><span className="flex items-center gap-2 font-semibold whitespace-nowrap"><Crest team={r.team} size={20} />{r.team}</span></td>
                {r.cells.map((list, i) => (
                  <td key={i} className="px-1 py-1 border-b align-middle" style={{ borderColor: "#EEF2F8" }}>
                    {list.length === 0 ? <div className="rounded-md py-2 text-center text-xs font-semibold" style={{ border: "1px dashed #C5D0E0", color: "#98A6BC" }}>–</div>
                      : <div className="space-y-0.5">{list.map((f, j) => { const [bg, fg] = f.diff != null ? DIFF_STYLE[f.diff] : ["#EEF2F8", INK];
                        return <div key={j} title={(f.home ? "Home v " : "Away at ") + (TEAM_BY_SHORT[f.opp] || f.opp) + (f.diff != null ? ", difficulty " + f.diff + " (" + DIFF_WORD[f.diff] + ")" : "")} className="rounded-md py-1.5 text-center text-xs font-bold whitespace-nowrap" style={{ background: bg, color: fg }}>{f.opp} <span className="font-semibold opacity-80">({f.home ? "H" : "A"})</span></div>; })}</div>}
                  </td>
                ))}
                <td className="px-2 py-1 border-b text-center" style={{ borderColor: "#EEF2F8" }}>{r.avg != null ? <span className="inline-block rounded-md px-2 py-1 text-xs font-extrabold tabular-nums" style={{ background: avgStyle(r.avg)[0], color: avgStyle(r.avg)[1] }}>{r.avg.toFixed(1)}</span> : <span style={{ color: "#98A6BC" }}>–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-xs" style={{ color: MUTED }}>
        {[1, 2, 3, 4, 5].map((d) => <span key={d} className="inline-flex items-center gap-1.5"><DiffPill d={d} wide /> {DIFF_WORD[d]}</span>)}
        <span>Two fixtures in a box means a double gameweek. A dash means no game.</span>
      </div>
    </div>
  );
}

/* ---- News tab: official availability notes plus headlines from the news sites ---- */
function NewsView({ news, now }) {
  const [club, setClub] = useState("ALL"); const [kind, setKind] = useState("ALL"); const [avail, setAvail] = useState("ALL"); const [more, setMore] = useState(false);
  const clubId = club === "ALL" ? null : TEAM_ID[club];
  const heads = (news || []).filter((n) => (kind === "ALL" || n.kind === kind) && (!clubId || (n.team_ids || []).includes(clubId)));
  const players = useMemo(() => PL_POOL.filter((p) => ["d", "i", "s"].includes(p.status) && p.news && (club === "ALL" || p.team === club) && (avail === "ALL" || (avail === "out" ? p.status !== "d" : p.status === "d")))
    .sort((a, b) => String(b.newsAdded || "").localeCompare(String(a.newsAdded || "")) || b.rating - a.rating || a.name.localeCompare(b.name)), [club, avail, PL_POOL.length]);
  const shown = players.slice(0, more ? 60 : 12);
  const field = "px-3 py-2 rounded-xl bg-white border text-sm focus:outline-none focus:ring-2";
  const chip = (v, cur, set, label) => <button key={v} onClick={() => set(v)} className={"px-3 py-1 rounded-full text-xs font-semibold border transition-colors " + (cur === v ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={cur === v ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{label}</button>;
  return (
    <div>
      <h2 className="text-3xl mb-1" style={HEAD}>Team news</h2>
      <p className="text-sm mb-4 max-w-2xl" style={{ color: MUTED }}>Injuries, suspensions and line-up news. Availability notes come from the official Fantasy Premier League feed. Headlines come from several news sites and link back to the original story.</p>
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <select value={club} onChange={(e) => setClub(e.target.value)} className={field} style={{ borderColor: LINE, "--tw-ring-color": BLUE }} aria-label="Filter by club">
          <option value="ALL">All clubs</option>{TEAM_LIST.map((t) => <option key={t} value={t}>{t}</option>)}</select>
      </div>
      <div className="grid lg:grid-cols-2 gap-5 items-start">
        <section>
          <div className="flex items-center justify-between gap-2 mb-2"><h3 className="font-bold flex items-center gap-2"><AlertTriangle size={16} style={{ color: "#B45309" }} /> Player availability</h3>
            <div className="flex gap-1.5">{chip("ALL", avail, setAvail, "All")}{chip("out", avail, setAvail, "Out")}{chip("d", avail, setAvail, "Doubtful")}</div></div>
          <div className="space-y-1.5">
            {shown.length === 0 && <div className="rounded-xl border border-dashed p-5 text-sm text-center" style={{ borderColor: "#C5D0E0", color: MUTED }}>No injury or suspension notes to show.</div>}
            {shown.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5 rounded-xl border bg-white px-3 py-2.5" style={{ borderColor: LINE }}>
                <Crest team={p.team} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap"><span className="font-semibold text-sm">{p.name}</span><PosChip pos={p.pos} /><AvailChip p={p} /></div>
                  <div className="text-xs mt-0.5" style={{ color: MUTED }}>{p.news}</div>
                </div>
                {p.newsAdded && <span className="text-[11px] shrink-0" style={{ color: MUTED }}>{ago(p.newsAdded, now)}</span>}
              </div>
            ))}
          </div>
          {players.length > 12 && <div className="flex justify-center mt-3"><button onClick={() => setMore(!more)} className="px-4 py-1.5 rounded-full text-sm font-semibold border bg-white hover:bg-black/5 flex items-center gap-1.5" style={{ borderColor: LINE, color: BLUE }}>{more ? "Show less" : "Show more (" + Math.min(players.length, 60) + ")"} <ChevronDown size={14} className={more ? "rotate-180" : ""} /></button></div>}
        </section>
        <section>
          <div className="flex items-center justify-between gap-2 mb-2"><h3 className="font-bold flex items-center gap-2"><Newspaper size={16} style={{ color: BLUE }} /> Headlines</h3>
            <div className="flex gap-1.5">{chip("ALL", kind, setKind, "All")}{chip("injury", kind, setKind, "Injuries")}{chip("lineup", kind, setKind, "Line-ups")}</div></div>
          <div className="space-y-1.5">
            {heads.length === 0 && <div className="rounded-xl border border-dashed p-5 text-sm text-center" style={{ borderColor: "#C5D0E0", color: MUTED }}>{(news || []).length ? "No headlines match those filters." : "Headlines appear here once the team news job has run."}</div>}
            {heads.slice(0, 25).map((n) => <NewsItem key={n.id} n={n} now={now} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---- Plan: draft the next few gameweeks, see fixtures and rough point estimates, then save what you are sure about. ---- */
const POS4 = ["GK", "DEF", "MID", "FWD"];
const fxLabel = (list) => (list && list.length ? list.map((f) => f.opp + (f.home ? " (H)" : " (A)")).join(", ") : "No game");

function PlanPicker({ gw, pos, fx, estOf, used, clubs, currentId, onChoose, onRemove, onClose }) {
  const [q, setQ] = useState("");
  useEffect(() => { const h = (e) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return PL_POOL.filter((p) => p.pos === pos && (!s || `${p.name} ${p.team}`.toLowerCase().includes(s)))
      .map((p) => { const list = (fx[p.team] || {})[gw] || []; return { p, list, est: estOf(p, list) }; })
      .sort((a, b) => b.est - a.est || b.p.pts - a.p.pts || a.p.name.localeCompare(b.p.name));
  }, [q, pos, gw, fx]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={"Choose a " + POS_ONE[pos]}>
      <div className="absolute inset-0" style={{ background: "rgba(10,35,66,0.55)" }} onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white" style={{ boxShadow: "0 20px 60px rgba(10,35,66,0.4)" }}>
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
          <div><div className="font-bold">GW{gw} · choose a {POS_ONE[pos]}</div><div className="text-xs" style={{ color: MUTED }}>Best estimate first (form, fixture difficulty and fitness). Greyed out: already picked or planned this period, or the same club as another pick this gameweek.</div></div>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm font-semibold hover:bg-black/5" style={{ color: MUTED }}>Close</button>
        </div>
        <div className="px-4 pb-2 flex gap-2">
          <div className="relative flex-1"><Search size={16} className="absolute left-3 top-2.5" style={{ color: MUTED }} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players or clubs" className="w-full pl-9 pr-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2" style={{ borderColor: LINE, "--tw-ring-color": BLUE }} /></div>
          {currentId && <button onClick={onRemove} className="px-3 py-2 rounded-xl text-sm font-semibold border hover:bg-black/5" style={{ borderColor: LINE, color: "#BE123C" }}>Remove</button>}
        </div>
        <div className="overflow-y-auto px-2 pb-3">
          {rows.length === 0 && <div className="px-3 py-6 text-sm text-center" style={{ color: MUTED }}>No one matches that search.</div>}
          {rows.slice(0, 80).map(({ p, list, est }) => {
            const u = used[p.id]; const clubTaken = clubs.has(p.team); const blocked = (u || clubTaken) && p.id !== currentId; const here = p.id === currentId;
            return (
              <button key={p.id} disabled={blocked} onClick={() => onChoose(p.id)}
                className={"w-full flex items-center gap-3 text-left rounded-xl px-3 py-2 border border-transparent transition-colors " + (blocked ? "opacity-45 cursor-not-allowed" : "hover:bg-black/5")}
                style={here ? { borderColor: BLUE, background: "rgba(31,78,156,0.06)" } : undefined}>
                <Crest team={p.team} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold"><span className="truncate">{p.name}</span>
                    <AvailChip p={p} />
                    {blocked && <span className="inline-flex items-center gap-1 text-[11px] font-semibold shrink-0" style={{ color: MUTED }}><Lock size={11} /> {u ? (u.planned ? "Planned GW" : "Picked GW") + u.gw : "Club already in GW" + gw}</span>}</span>
                  <span className="block text-[11px]" style={{ color: MUTED }}>{p.team} · <FxInline list={list} /> · form {p.form.toFixed(1)}</span>
                  {p.news && p.status !== "a" && <span className="block text-[11px] truncate" style={{ color: "#B45309" }} title={p.news}>{p.news}</span>}
                </span>
                <span className="text-right shrink-0"><span className="block text-sm font-extrabold tabular-nums" style={{ color: list.length ? BLUE : "#98A6BC" }}>{list.length ? est.toFixed(1) : "0"}</span><span className="block text-[10px]" style={{ color: MUTED }}>est pts</span></span>
              </button>
            );
          })}
          {rows.length > 80 && <div className="px-3 py-2 text-xs text-center" style={{ color: MUTED }}>Showing the top 80. Search to narrow it down.</div>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Home: a condensed view of this gameweek ---------------- */
function HomeCard({ title, icon: Icon, right, children, className = "" }) {
  return (
    <section className={"rounded-2xl bg-white border " + className} style={{ borderColor: LINE, boxShadow: SHADOW }}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-4 pb-3">
        <h3 className="font-extrabold flex items-center gap-2" style={{ letterSpacing: "-0.01em" }}>{Icon && <Icon size={16} className="shrink-0" style={{ color: BLUE }} />}{title}</h3>
        {right}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function HomeView({ user, currentGW, now, closed, over, official, ctx, myPts, news, board, myRank, myTotal, periodLabel, lastWeekPts, onGo }) {
  const fx = getTeamFixtures();
  const [lw, setLw] = useState(null);
  const [pos, setPos] = useState("ALL");
  const lastGW = currentGW > 1 ? currentGW - 1 : 0;
  useEffect(() => {
    if (!lastGW) { setLw([]); return; }
    let off = false;
    api.loadGwPoints(lastGW).then((r) => { if (!off) setLw(r); }).catch(() => { if (!off) setLw([]); });
    return () => { off = true; };
  }, [lastGW]);

  const hour = Number(ukPart(UK_TIME, new Date(now).toISOString(), "hour"));
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const bySlot = !!(official && official.bySlot);
  const picked = [...ctx.curIds].map((id) => BY_ID[id]).filter(Boolean);
  const slots = bySlot ? ["GK", "DEF", "MID", "FWD"].map((p) => ({ pos: p, pl: picked.find((x) => x.pos === p) })) : [{ pos: null, pl: picked[0] }];
  const filled = slots.filter((s) => s.pl).length;
  const ptsOf = (pl) => { const r = myPts[pl.id + "|" + currentGW]; return r ? r.points : null; };
  const playing = useMemo(() => new Set(FIXTURES.filter((f) => f[0] === currentGW).flatMap((f) => [TEAM_BY_SHORT[f[1]], TEAM_BY_SHORT[f[2]]])), [currentGW, FIXTURES.length]);
  const myClubs = new Set(picked.map((p) => p.team));

  // top scorers from the last scored gameweek
  const scorers = (lw || []).filter((r) => r.points > 0 && BY_ID[r.player_id] && (pos === "ALL" || BY_ID[r.player_id].pos === pos))
    .sort((a, b) => b.points - a.points || BY_ID[a.player_id].name.localeCompare(BY_ID[b.player_id].name)).slice(0, 5);
  const maxPts = scorers.length ? scorers[0].points : 1;

  // news: flagged picks first, then headlines from clubs that play this gameweek
  const flagged = picked.filter((p) => availLabel(p));
  const heads = (news || []).filter((n) => (n.team_ids || []).some((id) => playing.has(TEAM_NAME[id]))).slice(0, 3);
  const fixtures = FIXTURES.filter((f) => f[0] === currentGW);
  const days = []; fixtures.forEach((f) => { const d = f[3] ? koDay(f[3]) : "Date to be confirmed"; const l = days[days.length - 1]; if (l && l.day === d) l.items.push(f); else days.push({ day: d, items: [f] }); });
  const top3 = board.slice(0, 3); const meIn = top3.some((r) => r.id === user.id); const me = board.find((r) => r.id === user.id);

  return (
    <div className="space-y-5 overflow-x-hidden">
      {/* hero */}
      <section className="relative overflow-hidden rounded-3xl text-white" style={{ background: PITCH, boxShadow: "0 18px 50px rgba(10,35,66,0.28)" }}>
        <svg className="absolute -right-24 -top-24 opacity-10 pointer-events-none" width="420" height="420" viewBox="0 0 200 200" fill="none" stroke="#fff" strokeWidth="1.5" aria-hidden="true"><circle cx="100" cy="100" r="60" /><circle cx="100" cy="100" r="3" fill="#fff" /><path d="M0 100H200" /></svg>
        <div className="relative p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: "rgba(255,255,255,0.75)" }}>{hello}, {user.username}</div>
              <div className="text-4xl sm:text-5xl mt-1" style={{ ...HEAD, lineHeight: 1.02 }}>Gameweek {currentGW}</div>
              <div className="mt-2 inline-flex flex-wrap items-center gap-2 text-sm">
                {over ? <span className="font-semibold">The season is complete.</span> : closed ? <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: VOLT }}><Lock size={14} /> Picks are locked</span> : <>
                  <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-bold" style={{ background: "rgba(217,246,59,0.16)", color: VOLT }}><Flame size={14} />{untilDeadline(currentGW, now)}</span>
                  <span style={{ color: "rgba(255,255,255,0.8)" }}>Deadline {koDay(deadlineOf(currentGW))}, {koTime(deadlineOf(currentGW))}</span></>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {[[periodLabel ? "Rank in " + periodLabel : "Rank", "#" + myRank + " of " + Math.max(board.length, 1)], [periodLabel ? "Points in " + periodLabel : "Points", String(myTotal)], ...(lastWeekPts != null ? [["Last gameweek", lastWeekPts + " pts"]] : [])].map(([k, v]) => (
                <div key={k} className="rounded-2xl px-3.5 py-2.5 min-w-[84px]" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.14)" }}>
                  <div className="text-[11px] font-semibold leading-tight" style={{ color: "rgba(255,255,255,0.7)" }}>{k}</div>
                  <div className="text-xl font-extrabold tabular-nums mt-0.5">{v}</div></div>))}
            </div>
          </div>

          <div className={"mt-6 grid gap-2.5 " + (bySlot ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:max-w-sm")}>
            {slots.map((s, i) => {
              const p = s.pl; const list = p ? (fx[p.team] || {})[currentGW] || [] : []; const pts = p ? ptsOf(p) : null;
              if (!p) return (
                <button key={i} onClick={() => onGo("pick")} disabled={closed || over} className="text-left rounded-2xl p-3.5 transition-colors hover:bg-white/10 disabled:opacity-60" style={{ border: "2px dashed rgba(255,255,255,0.35)" }}>
                  <div className="flex items-center justify-between">{s.pos ? <PosChip pos={s.pos} /> : <span className="text-xs font-bold">Your pick</span>}<Plus size={16} style={{ color: VOLT }} /></div>
                  <div className="font-bold mt-3" style={{ color: closed ? "rgba(255,255,255,0.6)" : VOLT }}>{closed ? "Not picked" : s.pos ? "Pick a " + POS_ONE[s.pos] : "Make your pick"}</div>
                  <div className="text-[11px]" style={{ color: "rgba(255,255,255,0.6)" }}>{closed ? "Scores 0" : "Tap to choose"}</div>
                </button>);
              return (
                <div key={i} className="rounded-2xl p-3.5 bg-white text-left" style={{ color: INK }}>
                  <div className="flex items-center justify-between gap-2"><PosChip pos={p.pos} /><AvailChip p={p} />{pts != null && <span className="ml-auto text-xl font-extrabold tabular-nums" style={{ color: BLUE }}>{pts}</span>}</div>
                  <div className="flex items-center gap-2 mt-2.5"><Crest team={p.team} size={26} /><div className="min-w-0"><div className="font-extrabold leading-tight truncate">{p.name}</div><div className="text-[11px] truncate" style={{ color: MUTED }}>{p.team}</div></div></div>
                  <div className="mt-2 text-[11px]" style={{ color: MUTED }}>{list.length ? <FxInline list={list} /> : "No game this week"}</div>
                </div>);
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {!over && <button onClick={() => onGo("pick")} className="px-5 py-2.5 rounded-xl font-extrabold hover:brightness-95 transition" style={{ background: VOLT, color: INK }}>{closed ? "See the pick screen" : filled === slots.length ? "Edit your picks" : filled ? "Finish your picks" : "Make your picks"}</button>}
            {bySlot && !closed && <button onClick={() => onGo("plan")} className="px-5 py-2.5 rounded-xl font-semibold border border-white/35 hover:bg-white/10 transition-colors">Plan ahead</button>}
            <span className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>{filled} of {slots.length} picked{ctx.progress ? " · " + ctx.progress.used + " of " + ctx.progress.total + " used this " + (periodLabel ? "period" : "round") : ""}</span>
          </div>
        </div>
      </section>

      <div className="grid lg:grid-cols-3 gap-5">
        <HomeCard className="lg:col-span-2" title={lastGW ? "Top scorers, gameweek " + lastGW : "Top scorers"} icon={Trophy}
          right={<div className="flex gap-1">{["ALL", "GK", "DEF", "MID", "FWD"].map((k) => <button key={k} onClick={() => setPos(k)} className={"px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors " + (pos === k ? "text-white border-transparent" : "bg-white hover:bg-black/5")} style={pos === k ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>{k === "ALL" ? "All" : k}</button>)}</div>}>
          {lw === null ? <div className="py-6 text-sm text-center" style={{ color: MUTED }}>Loading…</div> : scorers.length === 0 ? <div className="py-6 text-sm text-center" style={{ color: MUTED }}>Scores appear here once a gameweek has been played.</div> : (
            <div className="space-y-1.5">
              {scorers.map((r, i) => { const p = BY_ID[r.player_id]; const note = whatScored(r.breakdown); return (
                <div key={r.player_id} className="flex items-center gap-3 rounded-xl px-2.5 py-2" style={{ background: i === 0 ? "rgba(217,246,59,0.2)" : "#F7F9FC" }}>
                  <span className="w-5 text-center text-sm font-extrabold tabular-nums" style={{ color: MUTED }}>{i === 0 ? <Crown size={16} className="mx-auto" style={{ color: "#C9A400" }} /> : i + 1}</span>
                  <Crest team={p.team} size={28} />
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 font-bold leading-tight"><span className="truncate">{p.name}</span><PosChip pos={p.pos} /></div>
                    <div className="text-[11px] truncate" style={{ color: MUTED }}>{note || p.team}</div>
                    <div className="h-1 rounded-full mt-1.5 hidden sm:block" style={{ background: "#E3E9F2" }}><div className="h-1 rounded-full" style={{ width: Math.max(8, Math.round((r.points / maxPts) * 100)) + "%", background: BLUE }} /></div></div>
                  <span className="text-2xl font-extrabold tabular-nums" style={{ color: BLUE }}>{r.points}</span>
                </div>); })}
            </div>)}
          <button onClick={() => onGo("pick")} className="mt-3 text-sm font-semibold" style={{ color: BLUE }}>See more on the pick screen →</button>
        </HomeCard>

        <HomeCard title="Top news" icon={Newspaper} right={<button onClick={() => onGo("news")} className="text-xs font-semibold" style={{ color: BLUE }}>All team news →</button>}>
          <div className="space-y-2">
            {flagged.length > 0 && <div className="rounded-xl px-3 py-2.5 bg-amber-50 border border-amber-200">
              <div className="text-xs font-bold text-amber-900 mb-1 flex items-center gap-1.5"><AlertTriangle size={13} /> Check your picks</div>
              {flagged.map((p) => <div key={p.id} className="text-sm"><span className="font-semibold">{p.name}</span> <AvailChip p={p} /> <span className="text-xs" style={{ color: MUTED }}>{p.news}</span></div>)}</div>}
            {heads.map((n) => <NewsItem key={n.id} n={n} now={now} />)}
            {!flagged.length && !heads.length && <div className="py-5 text-sm text-center" style={{ color: MUTED }}>No injury or line-up news for this gameweek yet.</div>}
          </div>
        </HomeCard>
      </div>

      <div className="grid lg:grid-cols-5 gap-5">
        <HomeCard className="lg:col-span-3" title={"Gameweek " + currentGW + " fixtures"} icon={Calendar} right={<button onClick={() => onGo("fixtures")} className="text-xs font-semibold" style={{ color: BLUE }}>Difficulty →</button>}>
          {days.length === 0 ? <div className="py-4 text-sm" style={{ color: MUTED }}>No fixtures scheduled.</div> : (
            <div className="space-y-3">
              {days.map((d) => <div key={d.day}>
                <div className="text-[11px] font-bold tracking-wide mb-1" style={{ color: MUTED }}>{d.day.toUpperCase()}</div>
                <div className="space-y-1">{d.items.map((f, i) => { const hn = TEAM_BY_SHORT[f[1]], an = TEAM_BY_SHORT[f[2]]; const mine = myClubs.has(hn) || myClubs.has(an); return (
                  <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: mine ? "rgba(217,246,59,0.28)" : "#F7F9FC" }} title={mine ? "One of your picks plays here" : undefined}>
                    <div className="flex items-center justify-end gap-1.5 min-w-0 text-sm font-bold"><span className="truncate">{f[1]}</span><Crest team={hn} size={20} /></div>
                    <div className="text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded" style={{ background: "#E3E9F2", color: INK }}>{f[3] ? koTime(f[3]) : "TBC"}</div>
                    <div className="flex items-center gap-1.5 min-w-0 text-sm font-bold"><Crest team={an} size={20} /><span className="truncate">{f[2]}</span></div>
                  </div>); })}</div></div>)}
              {myClubs.size > 0 && <div className="text-[11px]" style={{ color: MUTED }}><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1.5" style={{ background: "rgba(217,246,59,0.6)" }} />Matches with one of your picks</div>}
            </div>)}
        </HomeCard>

        <HomeCard className="lg:col-span-2" title={periodLabel ? "Table · " + periodLabel : "Table"} icon={Crown} right={<button onClick={() => onGo("leagues")} className="text-xs font-semibold" style={{ color: BLUE }}>All leagues →</button>}>
          {board.length === 0 ? <div className="py-4 text-sm" style={{ color: MUTED }}>No scores yet.</div> : (
            <div>
              {top3.map((r, i) => <div key={r.id} className="flex items-center gap-3 py-2.5 border-b last:border-0" style={{ borderColor: "#EEF2F8", background: r.id === user.id ? "rgba(31,78,156,0.05)" : undefined }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold" style={{ background: i === 0 ? VOLT : "#E3E9F2" }}>{i + 1}</span>
                <span className="flex-1 font-semibold truncate">{r.name}{r.id === user.id && <span className="text-xs font-normal" style={{ color: MUTED }}> (you)</span>}</span>
                <span className="font-extrabold tabular-nums" style={{ color: BLUE }}>{r.total}</span></div>)}
              {!meIn && me && <div className="flex items-center gap-3 py-2.5 mt-1 rounded-lg px-2 -mx-2" style={{ background: "rgba(31,78,156,0.06)" }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold" style={{ background: "#E3E9F2" }}>{myRank}</span>
                <span className="flex-1 font-semibold">{me.name} <span className="text-xs font-normal" style={{ color: MUTED }}>(you)</span></span><span className="font-extrabold tabular-nums" style={{ color: BLUE }}>{me.total}</span></div>}
            </div>)}
        </HomeCard>
      </div>
    </div>
  );
}

function PlanView({ uid, mine, format, currentGW, now, onSave, news }) {
  const KEY = "onepick-plan-" + uid;
  const [draft, setDraft] = useState(() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } });
  const [horizon, setHorizon] = useState(4);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* private window: the plan just won't survive a refresh */ } }, [draft]);

  const gws = GAMEWEEKS.filter((g) => g.id >= currentGW && g.id < currentGW + horizon && !isLocked(g.id, now)).map((g) => g.id);
  const fx = getTeamFixtures();
  const real = (gw, pos) => (mine[gw] || {})[pos] || null;
  const eff = (gw, pos, d = draft) => { if (isLocked(gw, now)) return real(gw, pos); const x = d[gw]; return x && x[pos] !== undefined ? x[pos] : real(gw, pos); };
  const monthOf = (gw) => periodOf(format, gw);
  const usedMap = (gw, d = draft) => { const out = {}; const m = monthOf(gw); if (m) m.gws.forEach((g) => POS4.forEach((pos) => { const id = eff(g, pos, d); if (id) { const dv = !isLocked(g, now) && d[g] && d[g][pos] !== undefined && d[g][pos] !== real(g, pos); out[id] = { gw: g, pos, planned: !!dv }; } })); return out; };
  const clubsIn = (gw, pos, d = draft) => { const out = new Set(); POS4.forEach((q) => { if (q === pos) return; const id = eff(gw, q, d); if (id && BY_ID[id]) out.add(BY_ID[id].team); }); return out; };
  const estOf = (gw) => (p, list) => estimateFor(p, list, gw === currentGW);
  const estFor = (pid, gw) => { const p = BY_ID[pid]; return p ? estimateFor(p, (fx[p.team] || {})[gw] || [], gw === currentGW) : 0; };

  const changes = [];
  gws.forEach((gw) => POS4.forEach((pos) => { const x = draft[gw]; if (x && x[pos] !== undefined && x[pos] !== real(gw, pos)) changes.push({ gw, pos, pid: x[pos] }); }));
  const setCell = (gw, pos, pid) => setDraft((d) => ({ ...d, [gw]: { ...(d[gw] || {}), [pos]: pid } }));
  const undoGw = (gw) => setDraft((d) => { const n = { ...d }; delete n[gw]; return n; });

  const suggest = () => {
    const next = JSON.parse(JSON.stringify(draft));
    const cells = []; gws.forEach((gw) => POS4.forEach((pos) => { if (!eff(gw, pos, next)) cells.push({ gw, pos }); }));
    while (cells.length) {
      let best = null;
      for (const c of cells) {
        const used = usedMap(c.gw, next); const clubs = clubsIn(c.gw, c.pos, next);
        for (const p of PL_POOL) {
          if (p.pos !== c.pos || used[p.id] || clubs.has(p.team) || p.status !== "a") continue;
          const e = estimateFor(p, (fx[p.team] || {})[c.gw] || [], c.gw === currentGW);
          if (e > 0 && (!best || e > best.e)) best = { c, p, e };
        }
      }
      if (!best) break;
      (next[best.c.gw] = next[best.c.gw] || {})[best.c.pos] = best.p.id;
      cells.splice(cells.indexOf(best.c), 1);
    }
    setDraft(next); setMsg("Filled the empty slots with the best-looking options. Change anything you like.");
  };
  const save = async (list) => {
    if (!list.length || busy) return; setBusy(true); setMsg("");
    const r = await onSave(list);
    setBusy(false);
    setMsg(r.failed ? `${r.ok} saved, ${r.failed} couldn't be saved. A deadline may have passed, or a player is already used this period.` : `Saved ${r.ok} ${r.ok === 1 ? "pick" : "picks"}. They're real now, and you can change them until each deadline.`);
  };

  const planned = []; gws.forEach((gw) => POS4.forEach((pos) => { const id = eff(gw, pos); if (id && BY_ID[id]) planned.push({ gw, p: BY_ID[id] }); }));
  const flagged = planned.filter((x) => availLabel(x.p));
  const plannedIds = new Set(planned.map((x) => x.p.id)); const plannedClubs = new Set(planned.map((x) => TEAM_ID[x.p.team]));
  const planNews = (news || []).filter((n) => (n.player_ids || []).some((id) => plannedIds.has(id)) || (n.team_ids || []).some((id) => plannedClubs.has(id))).slice(0, 4);
  let planTotal = 0; let prevMonth = null;   // "month" names are historic: these are periods
  const cards = gws.map((gw) => {
    const m = monthOf(gw); const banner = m && m.id !== prevMonth ? m : null; prevMonth = m && m.id;
    const gwChanges = changes.filter((c) => c.gw === gw);
    let tot = 0; POS4.forEach((pos) => { const id = eff(gw, pos); if (id) tot += estFor(id, gw); }); planTotal += tot;
    const filled = POS4.filter((pos) => eff(gw, pos)).length;
    return (
      <div key={gw} className={banner ? "lg:col-span-2" : ""}>
        {banner && <div className="text-xs font-semibold rounded-lg px-3 py-2 mb-2" style={{ background: "rgba(217,246,59,0.35)", color: INK }}>
          {banner.label}: {gw === gws[0] && Object.keys(usedMap(gw)).length ? "players you've used in this period are unavailable until GW" + (banner.gws[banner.gws.length - 1] + 1) + "." : "a fresh start. Every player is available again."}</div>}
        <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b" style={{ borderColor: "#EEF2F8", background: "#F7F9FC" }}>
            <div><div className="font-extrabold">Gameweek {gw}</div><div className="text-xs" style={{ color: MUTED }}>Deadline {koDay(deadlineOf(gw))}, {koTime(deadlineOf(gw))} · {untilDeadline(gw, now)}</div></div>
            <div className="text-right"><div className="text-sm font-extrabold tabular-nums" style={{ color: BLUE }}>{tot.toFixed(1)}</div><div className="text-[10px]" style={{ color: MUTED }}>est pts · {filled}/4</div></div>
          </div>
          <div className="p-2.5 space-y-1.5">
            {POS4.map((pos) => {
              const id = eff(gw, pos); const p = id ? BY_ID[id] : null; const r = real(gw, pos); const d = (draft[gw] || {})[pos];
              const changed = d !== undefined && d !== r;
              const tag = changed ? (id ? "Draft" : "Removing") : id ? "Saved" : null;
              const list = p ? (fx[p.team] || {})[gw] || [] : [];
              return (
                <button key={pos} onClick={() => setTarget({ gw, pos })} className="w-full flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-black/5"
                  style={changed ? { borderColor: VOLT, borderWidth: 2, background: "rgba(217,246,59,0.15)" } : id ? { borderColor: BLUE, background: "rgba(31,78,156,0.05)" } : { borderColor: LINE, borderStyle: "dashed" }}>
                  <PosChip pos={pos} />
                  {p ? (<>
                    <Crest team={p.team} size={24} />
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-sm font-semibold"><span className="truncate">{p.name}</span><AvailChip p={p} /></span>
                      <span className="block text-[11px]" style={{ color: MUTED }}><FxInline list={list} /></span></span>
                    <span className="text-right shrink-0"><span className="block text-sm font-bold tabular-nums">{estFor(id, gw).toFixed(1)}</span><span className="block text-[10px] font-semibold" style={{ color: tag === "Saved" ? BLUE : MUTED }}>{tag}</span></span>
                  </>) : (<>
                    <span className="flex-1 text-sm" style={{ color: MUTED }}>Choose a {POS_ONE[pos]}</span>
                    {tag === "Removing" ? <span className="text-[10px] font-semibold" style={{ color: "#BE123C" }}>Removing</span> : <Plus size={15} style={{ color: MUTED }} />}
                  </>)}
                </button>
              );
            })}
          </div>
          {gwChanges.length > 0 && <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t" style={{ borderColor: "#EEF2F8" }}>
            <button onClick={() => undoGw(gw)} className="text-xs font-semibold underline underline-offset-2" style={{ color: MUTED }}>Undo changes</button>
            <button onClick={() => save(gwChanges)} disabled={busy} className="px-3.5 py-1.5 rounded-lg text-sm font-bold text-white hover:brightness-110 disabled:opacity-60" style={{ background: BLUE }}>Save GW{gw}</button>
          </div>}
        </div>
      </div>
    );
  });

  const chip = (n) => <button key={n} onClick={() => setHorizon(n)} className={"px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors " + (horizon === n ? "text-white border-transparent" : "bg-white hover:bg-black/5")}
    style={horizon === n ? { background: DEEP } : { color: MUTED, borderColor: LINE }}>Next {n}</button>;
  return (
    <div>
      <h2 className="text-3xl mb-1" style={HEAD}>Plan ahead</h2>
      <p className="text-sm mb-4 max-w-2xl" style={{ color: MUTED }}>Try out the next few gameweeks. Players you've already picked or planned are greyed out, and you can't pick two from the same club in one gameweek. Drafts stay on this device and score nothing until you save them. Saved picks are real, and you can still change them until each deadline. Estimates combine recent form, the number of games, fixture difficulty and fitness, so treat them as a rough guide.</p>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1.5">{[2, 3, 4, 6].map(chip)}</div>
        <div className="flex-1" />
        <button onClick={suggest} className="px-3.5 py-1.5 rounded-full text-sm font-semibold border bg-white hover:bg-black/5 inline-flex items-center gap-1.5" style={{ borderColor: LINE, color: BLUE }}><Flame size={14} /> Suggest picks</button>
        {changes.length > 0 && <button onClick={() => { setDraft({}); setMsg(""); }} className="px-3.5 py-1.5 rounded-full text-sm font-semibold border bg-white hover:bg-black/5" style={{ borderColor: LINE, color: MUTED }}>Clear drafts</button>}
        <button onClick={() => save(changes)} disabled={!changes.length || busy} className="px-4 py-1.5 rounded-full text-sm font-bold text-white hover:brightness-110 disabled:opacity-40" style={{ background: BLUE }}>{busy ? "Saving…" : changes.length ? "Save all (" + changes.length + ")" : "Nothing to save"}</button>
      </div>
      {(flagged.length > 0 || planNews.length > 0) && (
        <div className="mb-4 rounded-2xl border bg-white p-4 space-y-3" style={{ borderColor: LINE }}>
          {flagged.length > 0 && <div className="rounded-xl px-3 py-2.5 bg-amber-50 border border-amber-200">
            <div className="text-xs font-bold text-amber-900 mb-1 flex items-center gap-1.5"><AlertTriangle size={13} /> Fitness check on your plan</div>
            {flagged.map((f) => <div key={f.gw + f.p.id} className="text-sm"><span className="font-semibold">{f.p.name}</span> <span className="text-xs" style={{ color: MUTED }}>GW{f.gw}</span> <AvailChip p={f.p} /> <span className="text-xs" style={{ color: MUTED }}>{f.p.news}</span></div>)}
          </div>}
          {planNews.length > 0 && <div><div className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Latest headlines about clubs in your plan</div><div className="space-y-1.5">{planNews.map((n) => <NewsItem key={n.id} n={n} now={now} />)}</div></div>}
        </div>
      )}
      {msg && <div className="mb-4 rounded-xl px-3.5 py-2.5 text-sm font-medium" style={{ background: "rgba(31,78,156,0.08)", color: INK }} role="status">{msg}</div>}
      {gws.length === 0 ? <div className="rounded-2xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "#C5D0E0", color: MUTED }}>No open gameweeks to plan.</div> : (
        <>
          <div className="grid lg:grid-cols-2 gap-3 items-start">{cards}</div>
          <div className="mt-4 flex items-center justify-between rounded-2xl border bg-white px-4 py-3" style={{ borderColor: LINE }}>
            <span className="text-sm font-semibold">Plan total for {gws.length} {gws.length === 1 ? "gameweek" : "gameweeks"}</span>
            <span><span className="text-xl font-extrabold tabular-nums" style={{ color: BLUE }}>{planTotal.toFixed(1)}</span> <span className="text-xs" style={{ color: MUTED }}>estimated pts</span></span>
          </div>
        </>
      )}
      {target && <PlanPicker gw={target.gw} pos={target.pos} fx={fx} estOf={estOf(target.gw)} used={usedMap(target.gw)} clubs={clubsIn(target.gw, target.pos)} currentId={eff(target.gw, target.pos)}
        onChoose={(pid) => { setCell(target.gw, target.pos, pid); setTarget(null); setMsg(""); }}
        onRemove={() => { setCell(target.gw, target.pos, null); setTarget(null); setMsg(""); }} onClose={() => setTarget(null)} />}
    </div>
  );
}

function RulesView() {
  const rules = [
    { t: "Four picks a week", d: "Every gameweek, choose one goalkeeper, one defender, one midfielder and one forward. Your four slots reset every gameweek." },
    { t: "Once per period", d: "Once a player has been one of your picks, he's off the table for the rest of the period. In the main game a period is four gameweeks (GW1-4, GW5-8, GW9-12 and so on), and then everyone comes back. Spend the big names early or save them for the run-in. Your call, gaffer." },
    { t: "One per club", d: "You can't pick two players from the same club in the same gameweek, so spread your picks around." },
    { t: "Plan ahead", d: "The Plan tab lets you draft the next few gameweeks before committing. Drafts are just for you. Save a gameweek and those picks become real, and you can still change them until that gameweek's deadline." },
    { t: "Every point counts", d: "Goals, assists, clean sheets, saves and bonus points all score, and the amount depends on the position. The full table is below." },
    { t: "Most points wins", d: "Add up all four picks in every gameweek of the period. The highest total wins that period. Win a few and you're a legend." },
    { t: "Bring your mates", d: "Everyone is in the main game, with a new winner every four gameweeks. Or start your own league, share the code, and choose how long each period runs, from a block of gameweeks down to a single week, where you can pick the same player every week." },
  ];
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl mb-1" style={HEAD}>How it works</h2>
      <p className="mb-6" style={{ color: MUTED }}>{SUBTAGLINE}</p>
      <div className="space-y-3">
        {rules.map((r, i) => <div key={i} className="flex gap-3 rounded-2xl bg-white border p-4" style={{ borderColor: LINE, boxShadow: SHADOW }}>
          <div className="w-8 h-8 shrink-0 rounded-lg font-extrabold flex items-center justify-center tabular-nums" style={{ background: VOLT, color: INK }}>{i + 1}</div>
          <div><div className="font-bold">{r.t}</div><div className="text-sm mt-0.5" style={{ color: MUTED }}>{r.d}</div></div>
        </div>)}
      </div>
      <h3 className="text-2xl mt-8 mb-1" style={HEAD}>How points are scored</h3>
      <p className="text-sm mb-3" style={{ color: MUTED }}>The same actions score different amounts depending on the player's position.</p>
      <ScoringTable />
      <div className="mt-6 text-sm rounded-2xl border p-4 bg-white" style={{ borderColor: LINE, color: MUTED }}>
        <span className="font-semibold" style={{ color: INK }}>The small print:</span> picks lock at the gameweek deadline, and other people's picks stay hidden until then. If you leave a slot empty, it scores zero for that week.
      </div>
    </div>
  );
}
