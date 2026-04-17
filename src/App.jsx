import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, updateDoc, arrayUnion, runTransaction } from 'firebase/firestore';
import { Trophy, Clock, Shield, RotateCcw, Lock, ChevronRight, ArrowLeftRight } from 'lucide-react';

// --- CONFIG ---
const LEAGUE_LOGO = "https://i.imgur.com/tz2WUcI.png";
const ADMIN_TEAM_NAME = "The Sassy Boys";
const TEAMS_COUNT = 8;
const TOTAL_PICKS = 16;
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1494020176075689986/WEDJVhqheH9aY8VxWBr75s7H1HzOiNK-W_thu1XQ_elUmNqbrs7z6pJNogJsdVuME8G8";

const TEAMS = [
  { name: "The Golden Path", logo: "https://i.imgur.com/F4wgHz7.png", passcode: "3863", timeZone: "America/New_York", discordMention: "<@323174530283733002>" },
  { name: "Hinkie Sinkie", logo: "https://i.imgur.com/aiOnSde.png", passcode: "5280", timeZone: "America/Denver", discordMention: "<@1405014411852386334>" },
  { name: "The Sassy Boys", logo: "https://i.imgur.com/mDVtQsn.png", passcode: "7366", timeZone: "America/New_York", discordMention: "<@240613384045723648>" },
  { name: "Eternal Beans", logo: "https://i.imgur.com/0JY0Tsr.png", passcode: "2326", timeZone: "America/New_York", discordMention: "<@715743038877466656>" },
  { name: "FantaCTE Fooseball Team", logo: "https://i.imgur.com/wb9CZsl.png", passcode: "0420", timeZone: "America/Denver", discordMention: "<@621338847392825371>" },
  { name: "New England Patriots", logo: "https://i.imgur.com/LKwLUM5.png", passcode: "2803", timeZone: "America/New_York", discordMention: "<@338127259510767626>" },
  { name: "Richmond Rebels", logo: "https://i.imgur.com/hDpWB15.png", passcode: "2116", timeZone: "America/New_York", discordMention: "<@218519122005327874>" },
  { name: "This is your team on CTE", logo: "https://i.imgur.com/j4BaAQm.png", passcode: "0302", timeZone: "America/New_York", discordMention: "<@621370906396196866>" }
];

const DEFENSES = [
  { id: 'TEN', name: 'Tennessee Titans' }, { id: 'TB', name: 'Tampa Bay Buccaneers' },
  { id: 'NYJ', name: 'New York Jets' }, { id: 'NO', name: 'New Orleans Saints' },
  { id: 'MIA', name: 'Miami Dolphins' }, { id: 'LV', name: 'Las Vegas Raiders' },
  { id: 'KC', name: 'Kansas Chiefs' }, { id: 'IND', name: 'Indianapolis Colts' },
  { id: 'GB', name: 'Green Bay Packers' }, { id: 'DAL', name: 'Dallas Cowboys' },
  { id: 'CLE', name: 'Cleveland Browns' }, { id: 'CIN', name: 'Cincinnati Bengals' },
  { id: 'CHI', name: 'Chicago Bears' }, { id: 'CAR', name: 'Carolina Panthers' },
  { id: 'ATL', name: 'Atlanta Falcons' }, { id: 'ARI', name: 'Arizona Cardinals' }
];

const pad2 = (n) => String(n).padStart(2, '0');

// Parses "H:MM:SS" or "MM:SS" into milliseconds. Returns null if invalid.
function parseHmsToMs(hms) {
  const parts = String(hms).trim().split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) { [h, m, s] = parts; }
  else if (parts.length === 2) { [m, s] = parts; }
  else return null;
  if (h < 0 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return ((h * 3600) + (m * 60) + s) * 1000;
}

// --- QUIET HOURS HELPERS ---
// Returns true if the timestamp falls within 00:00–08:00 (local) for the given IANA timezone.
function isInQuietHours(ts, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false
    }).formatToParts(new Date(ts));
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const hour = h === 24 ? 0 : h; // some implementations return 24 for midnight
    return hour < 8;
  } catch {
    return false;
  }
}

// Returns the number of milliseconds of "active" (non-quiet-hours) time in [lastPickTime, now].
// Iterates in 1-minute steps; at most 720 steps for a 12-hour window — negligible cost.
function computeActiveElapsedMs(lastPickTime, now, timeZone) {
  const STEP = 60000; // 1 minute
  let quietMs = 0;
  let t = lastPickTime;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false
  });

  while (t < now) {
    const stepEnd = Math.min(t + STEP, now);
    const mid = (t + stepEnd) / 2;
    const parts = fmt.formatToParts(new Date(mid));
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const hour = h === 24 ? 0 : h;
    if (hour < 8) {
      quietMs += stepEnd - t;
    }
    t = stepEnd;
  }

  return (now - lastPickTime) - quietMs;
}

// Returns the wall-clock Unix timestamp (ms) at which 12 hours of active (non-quiet-hours) time
// will have elapsed since pickTime, using the given IANA timezone (quiet hours = 0–8 am).
// Iterates in 1-minute steps; at most ~4320 steps in the worst case — negligible cost.
function computeDeadlineMs(pickTime, timeZone) {
  const WINDOW_MS = 12 * 3600000;
  const STEP = 60000; // 1 minute
  let t = pickTime;
  let activeMs = 0;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false
  });

  while (activeMs < WINDOW_MS) {
    const stepEnd = t + STEP;
    const mid = (t + stepEnd) / 2;
    const parts = fmt.formatToParts(new Date(mid));
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const hour = h === 24 ? 0 : h;
    if (hour >= 8) {
      activeMs += STEP;
    }
    t = stepEnd;
  }

  return t;
}

// --- DISCORD HELPERS ---
// Posts a message to the Discord webhook. All mention strings go in `content` so they ping.
function sendDiscordMessage(content) {
  if (!DISCORD_WEBHOOK) return;
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(() => {});
}

// Uses a Firestore transaction to atomically claim a notification slot.
// Returns true if this client "won" (should send the ping), false if already sent.
async function claimAndNotify(docRef, field, value) {
  try {
    await runTransaction(db, async (txn) => {
      const snap = await txn.get(docRef);
      const data = snap.data() || {};
      const notifyData = data.notify || {};
      if (notifyData[field] === value) throw new Error('already_notified');
      txn.update(docRef, { [`notify.${field}`]: value });
    });
    return true;
  } catch {
    return false;
  }
}

// --- FIREBASE INITIALIZATION ---
// Using environment-provided config to prevent API key errors
const firebaseConfig = JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'enl-draft-v20';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export default function App() {
  const [user, setUser] = useState(null);
  const [myTeamIdx, setMyTeamIdx] = useState(() => {
    const saved = localStorage.getItem('enl_team_idx_v20');
    return saved !== null ? parseInt(saved) : null;
  });
  const [verifyingIdx, setVerifyingIdx] = useState(null);
  const [pin, setPin] = useState('');
  const [draft, setDraft] = useState(null);
  const [activeTab, setActiveTab] = useState('draft');
  const [timeLeft, setTimeLeft] = useState('--:--');
  
  // Admin Swap State
  const [swapA, setSwapA] = useState('');
  const [swapB, setSwapB] = useState('');

  // Admin Clock Override State (Sassy Boys only)
  const [overrideHms, setOverrideHms] = useState('1:00:00');
  const [overrideMinutesDelta, setOverrideMinutesDelta] = useState(10);

  // Refs for notification dedup within this client session
  const wasQuietRef = useRef(false);
  const sentOneHourForPickRef = useRef(null);
  // Tracks current effective remaining ms (updated each timer tick) for +/- buttons
  const currentEffectiveRemainingMsRef = useRef(0);

  // Handle Auth
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth failed", err);
      }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  // Handle Sync
  useEffect(() => {
    if (!user) return;

    // RULE 1: Use specific path structure
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setDraft(snap.data());
      } else {
        // Initialize Draft Data if missing in Firestore
        const pickMap = {};
        for (let p = 1; p <= TOTAL_PICKS; p++) {
          const round = Math.ceil(p / TEAMS_COUNT);
          const pos = (p - 1) % TEAMS_COUNT;
          const teamIdx = (round % 2 !== 0) ? pos : (TEAMS_COUNT - 1 - pos);
          pickMap[p] = TEAMS[teamIdx].name;
        }
        setDoc(docRef, {
          picks: [],
          currentPick: 1,
          lastPickTime: Date.now(),
          pickMap
        });
      }
    }, (err) => console.error("Snapshot error:", err));

    return () => unsubscribe();
  }, [user]);

  // OTC ping: fires when the current pick changes, pings the new OTC owner once per pick.
  useEffect(() => {
    if (!draft || !user || draft.currentPick > TOTAL_PICKS) return;
    // Skip if this pick has already been announced
    if ((draft.notify?.lastOtcPick ?? -1) === draft.currentPick) return;

    const pickNum = draft.currentPick;
    const teamName = draft.pickMap[pickNum];
    const team = TEAMS.find(t => t.name === teamName);
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');

    claimAndNotify(docRef, 'lastOtcPick', pickNum).then(won => {
      if (!won) return;
      const mention = team?.discordMention || '';
      sendDiscordMessage(`⏰ **Pick #${pickNum}** — **${teamName}** is on the clock! ${mention}`);
    }).catch(() => {});
  }, [user, draft?.currentPick, draft?.notify?.lastOtcPick]);

  // Auto-clear clockOverride when currentPick advances to a new pick.
  useEffect(() => {
    if (!draft || !user) return;
    if (draft.clockOverride && draft.clockOverride.pickNumber !== draft.currentPick) {
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
      updateDoc(docRef, { clockOverride: null }).catch(() => {});
    }
  }, [draft?.currentPick, user]);

  // Timer Effect — counts down active (non-quiet-hours) time within the 12-hour pick window.
  // Quiet hours are 12:00 AM–8:00 AM in the OTC team's local timezone; the clock is paused then.
  // Also handles resume ping (fires once when 8 AM quiet-hours end) and 1-hour warning ping.
  useEffect(() => {
    if (!draft || draft.currentPick > TOTAL_PICKS) return;
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    const interval = setInterval(() => {
      const currentPick = draft.currentPick;
      const otcTeamName = draft.pickMap[currentPick];
      const otcTeam = TEAMS.find(t => t.name === otcTeamName);
      const timeZone = otcTeam?.timeZone || 'America/New_York';

      const now = Date.now();
      const activeElapsedMs = computeActiveElapsedMs(draft.lastPickTime, now, timeZone);
      const WINDOW_MS = 12 * 3600000;
      const remainingMs = WINDOW_MS - activeElapsedMs;

      // If admin has set a clock override for this pick, count down from the stored remaining
      // using only active (non-quiet-hours) time elapsed since the override was set.
      let effectiveRemainingMs;
      if (draft.clockOverride?.pickNumber === currentPick) {
        const activeElapsedSinceSet = computeActiveElapsedMs(draft.clockOverride.setAt, now, timeZone);
        effectiveRemainingMs = Math.max(0, draft.clockOverride.activeRemainingMs - activeElapsedSinceSet);
      } else {
        effectiveRemainingMs = remainingMs;
      }
      currentEffectiveRemainingMsRef.current = effectiveRemainingMs;

      const nowQuiet = isInQuietHours(now, timeZone);

      if (effectiveRemainingMs <= 0) {
        setTimeLeft("00:00:00");
        wasQuietRef.current = nowQuiet;
        return;
      }

      const totalSeconds = Math.floor(effectiveRemainingMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      const secs = totalSeconds % 60;
      const timeStr = `${hours}:${pad2(mins)}:${pad2(secs)}`;

      if (nowQuiet) {
        setTimeLeft(`PAUSED \u2022 ${timeStr}`);
      } else {
        setTimeLeft(timeStr);
      }

      // Resume ping: fires exactly once when quiet hours end (transition from quiet → active).
      if (wasQuietRef.current && !nowQuiet) {
        if ((draft.notify?.lastResumePick ?? -1) !== currentPick) {
          const mention = otcTeam?.discordMention || '';
          claimAndNotify(docRef, 'lastResumePick', currentPick).then(won => {
            if (!won) return;
            sendDiscordMessage(`☀️ **Pick #${currentPick}** — Good morning **${otcTeamName}**, your clock has resumed! ${mention}`);
          }).catch(() => {});
        }
      }
      wasQuietRef.current = nowQuiet;

      // 1-hour remaining ping: fires once when active clock time drops below 1 hour.
      // Uses strict < to avoid firing immediately when admin sets override to exactly 1:00:00.
      if (!nowQuiet && effectiveRemainingMs < 3600000 && sentOneHourForPickRef.current !== currentPick) {
        if ((draft.notify?.lastOneHourPick ?? -1) !== currentPick) {
          sentOneHourForPickRef.current = currentPick;
          const mention = otcTeam?.discordMention || '';
          claimAndNotify(docRef, 'lastOneHourPick', currentPick).then(won => {
            if (!won) return;
            sendDiscordMessage(`⚠️ **Pick #${currentPick}** — **${otcTeamName}** has 1 hour of clock time remaining! ${mention}`);
          }).catch(() => {});
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [draft]);

  const handleJoin = () => {
    if (pin === TEAMS[verifyingIdx].passcode) {
      setMyTeamIdx(verifyingIdx);
      localStorage.setItem('enl_team_idx_v20', verifyingIdx);
      setVerifyingIdx(null);
      setPin('');
    } else {
      // Use custom notification instead of alert()
      console.log("Invalid PIN entered");
    }
  };

  const makePick = async (nflTeam, bypass = false) => {
    if (!user) return;
    const pNum = draft.currentPick;
    const fantasyTeam = bypass ? draft.pickMap[pNum] : TEAMS[myTeamIdx].name;
    const pickTime = Date.now();
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');

    try {
      await updateDoc(docRef, {
        picks: arrayUnion({ pickNumber: pNum, fantasyTeam, nflTeam }),
        currentPick: pNum + 1,
        lastPickTime: pickTime
      });

      if (DISCORD_WEBHOOK) {
        const nextPickNum = pNum + 1;
        const nextTeamName = draft.pickMap[nextPickNum];
        const nextTeam = TEAMS.find(t => t.name === nextTeamName);
        const otcMention = nextTeam?.discordMention || nextTeamName || '';
        const timeZone = nextTeam?.timeZone || 'America/New_York';
        const dstLogoUrl = `https://a.espncdn.com/i/teamlogos/nfl/500/${nflTeam.id.toLowerCase()}.png`;
        const fantasyTeamObj = TEAMS.find(t => t.name === fantasyTeam);
        const fantasyTeamLogo = fantasyTeamObj?.logo || LEAGUE_LOGO;

        const embedFields = [];
        if (nextTeamName) {
          const deadlineSec = Math.floor(computeDeadlineMs(pickTime, timeZone) / 1000);
          embedFields.push({ name: '🏈 On the Clock', value: `**${nextTeamName}** ${otcMention}`, inline: true });
          embedFields.push({ name: '⏰ Deadline', value: `**<t:${deadlineSec}:f>**`, inline: true });
        }

        fetch(DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: nextTeamName ? `🏈 **${nextTeamName}** is on the clock! ${otcMention}` : '',
            embeds: [{
              author: { name: fantasyTeam, icon_url: fantasyTeamLogo },
              title: `Pick #${pNum} is IN!`,
              description: `**${fantasyTeam}** drafted the **${nflTeam.name}** D/ST`,
              thumbnail: { url: dstLogoUrl },
              fields: embedFields,
              color: 0xfbbf24
            }]
          })
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Pick error", err);
    }
  };

  const swapDraftSlots = async () => {
    if (!user) return;
    if (!swapA || !swapB) return;
    if (swapA === swapB) return;

    const newPickMap = { ...draft.pickMap };
    const teamA = newPickMap[swapA]; // current team at slot swapA → will move to swapB
    const teamB = newPickMap[swapB]; // current team at slot swapB → will move to swapA

    newPickMap[swapA] = teamB;
    newPickMap[swapB] = teamA;

    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    try {
      await updateDoc(docRef, { pickMap: newPickMap });
      setSwapA('');
      setSwapB('');

      // Ping both owners about the swap (teamB is now at swapA, teamA is now at swapB)
      const teamObjForSlotA = TEAMS.find(t => t.name === teamB);
      const teamObjForSlotB = TEAMS.find(t => t.name === teamA);
      const mentionA = teamObjForSlotA?.discordMention || '';
      const mentionB = teamObjForSlotB?.discordMention || '';
      sendDiscordMessage(
        `🔄 **Draft slots swapped!**\n` +
        `Pick #${swapA} → **${teamB}** ${mentionA}\n` +
        `Pick #${swapB} → **${teamA}** ${mentionB}`
      );
    } catch (err) {
      console.error("Error swapping slots:", err);
    }
  };

  const undoPick = async () => {
    if (!user || draft.picks.length === 0) return;
    const newPicks = [...draft.picks];
    newPicks.pop();
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    await updateDoc(docRef, {
      picks: newPicks,
      currentPick: draft.currentPick - 1
    });
  };

  // Sets (or replaces) the clock override for the current pick. Admin-only (The Sassy Boys).
  const setClockOverrideRemainingMs = async (activeRemainingMs) => {
    if (!draft || !user) return;
    if (TEAMS[myTeamIdx]?.name !== ADMIN_TEAM_NAME) return;
    const WINDOW_MS = 12 * 3600000;
    const clamped = Math.max(0, Math.min(WINDOW_MS, activeRemainingMs));
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    await updateDoc(docRef, {
      clockOverride: {
        pickNumber: draft.currentPick,
        activeRemainingMs: clamped,
        setByTeam: TEAMS[myTeamIdx].name,
        setAt: Date.now(),
      }
    }).catch((err) => console.error("Clock override error", err));
  };

  const resetBoard = async () => {
    if (!user) return;
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    const pickMap = {};
    for (let p = 1; p <= TOTAL_PICKS; p++) {
      const round = Math.ceil(p / TEAMS_COUNT);
      const pos = (p - 1) % TEAMS_COUNT;
      const teamIdx = (round % 2 !== 0) ? pos : (TEAMS_COUNT - 1 - pos);
      pickMap[p] = TEAMS[teamIdx].name;
    }
    await setDoc(docRef, {
      picks: [],
      currentPick: 1,
      lastPickTime: Date.now(),
      pickMap
    });
  };

  if (!user || !draft) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-yellow-500">
        <div className="animate-spin mb-4 text-4xl">🏈</div>
        <div className="text-xs uppercase tracking-widest font-bold">Connecting...</div>
      </div>
    );
  }

  // --- Auth View ---
  if (myTeamIdx === null) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 flex items-center justify-center">
        <div className="w-full max-w-4xl">
          <div className="text-center mb-12">
            <img src={LEAGUE_LOGO} className="w-20 h-20 mx-auto mb-4" alt="League Logo" />
            <h1 className="text-3xl font-black text-white italic uppercase tracking-tighter">Enter the Draft Room</h1>
          </div>

          {verifyingIdx === null ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {TEAMS.map((t, i) => (
                <button
                  key={i}
                  onClick={() => setVerifyingIdx(i)}
                  className="bg-slate-900 border border-white/5 p-6 rounded-3xl hover:border-yellow-500 transition-all group"
                >
                  <img src={t.logo} className="w-12 h-12 mx-auto mb-3 object-contain group-hover:scale-110 transition-transform" />
                  <div className="text-[10px] font-black text-slate-400 uppercase">{t.name}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="max-w-sm mx-auto bg-slate-900 p-8 rounded-[2.5rem] border border-white/10 shadow-2xl">
              <h2 className="text-yellow-500 font-black uppercase text-center mb-6">{TEAMS[verifyingIdx].name}</h2>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="PIN"
                className="w-full bg-black border border-white/10 rounded-2xl p-4 text-center text-xl text-white outline-none focus:border-yellow-500 mb-4"
                onKeyPress={(e) => e.key === 'Enter' && handleJoin()}
              />
              <button
                onClick={handleJoin}
                className="w-full bg-yellow-500 text-black font-black p-4 rounded-2xl uppercase tracking-tighter"
              >
                Sign In
              </button>
              <button onClick={() => setVerifyingIdx(null)} className="w-full mt-4 text-[10px] text-slate-500 uppercase font-bold">Cancel</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const otcName = draft.pickMap[draft.currentPick];
  const isMyTurn = TEAMS[myTeamIdx].name === otcName;
  const isAdmin = TEAMS[myTeamIdx].name === ADMIN_TEAM_NAME;

  const isPaused = timeLeft.startsWith('PAUSED');
  const otcTeam = TEAMS.find(t => t.name === otcName);

  return (
    <div className="relative min-h-screen text-slate-200 overflow-hidden" style={{ background: 'linear-gradient(160deg, #022240 0%, #010d1a 60%, #000000 100%)' }}>
      {/* Radial glow — blue */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full opacity-20" style={{ background: 'radial-gradient(circle, #064b7f 0%, transparent 70%)' }} />
      {/* Radial glow — gold */}
      <div className="pointer-events-none absolute top-1/3 -right-32 w-[500px] h-[500px] rounded-full opacity-10" style={{ background: 'radial-gradient(circle, #ee9c02 0%, transparent 70%)' }} />
      {/* Scanline / noise overlay */}
      <div className="bg-esn-scanlines pointer-events-none absolute inset-0" style={{ zIndex: 0 }} />
      <div className="relative z-10 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center bg-slate-900/50 p-6 rounded-[2.5rem] border border-white/5 mb-8 gap-6">
          <div className="flex items-center gap-4">
            <img src={LEAGUE_LOGO} className="w-12 h-12" alt="ENL" />
            <div>
              <h1 className="text-xl font-black italic uppercase tracking-tighter text-white">ENL D/ST Draft</h1>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span className="text-[8px] uppercase text-white font-bold">Live System v2.0</span>
              </div>
            </div>
          </div>

          <nav className="flex bg-black p-1 rounded-2xl">
            {['draft', 'board', 'admin'].map((tab) => (
              (tab !== 'admin' || isAdmin) && (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase transition-all ${
                    activeTab === tab ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/20' : 'text-white hover:text-red-500'
                  }`}
                >
                  {tab}
                </button>
              )
            ))}
          </nav>

          <button 
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            className="text-[8px] font-black uppercase text-white/60 hover:text-red-500 transition-colors"
          >
            Logout
          </button>
        </header>

        {/* Views */}
        {activeTab === 'draft' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
              {/* OTC Status */}
              <div className={`rounded-[2.5rem] p-8 mb-8 flex flex-col md:flex-row justify-between items-center relative overflow-hidden transition-all ${
                isPaused
                  ? 'bg-[#022240]/80 border border-[#064b7f]/40'
                  : 'bg-slate-900 border border-[#ee9c02]/40 shadow-[0_0_32px_rgba(238,156,2,0.15)]'
              }`}>
                <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none"><Trophy size={100} /></div>
                <div>
                  <div className={`text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2 ${!isPaused ? 'text-yellow-400 animate-gold-text-glow' : 'text-white'}`}>
                    <Shield size={12} className="text-yellow-500" /> Currently Picking
                  </div>
                  <div className="text-3xl font-black italic uppercase text-yellow-500 truncate max-w-md">
                    {otcName || "DRAFT COMPLETE"}
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-6 md:mt-0 ml-auto">
                  {otcTeam?.logo && (
                    <img src={otcTeam.logo} className="w-14 h-14 object-contain rounded-full flex-shrink-0" alt={otcName} />
                  )}
                  <div className={`flex items-center gap-3 bg-black/40 px-6 py-4 rounded-3xl border border-white/5 ${!isPaused ? 'animate-gold-glow' : ''}`}>
                    <Clock size={20} className="text-white" />
                    <span className="text-2xl font-black font-mono text-white tracking-tighter">{timeLeft}</span>
                  </div>
                </div>
              </div>

              {/* Pool */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {DEFENSES.map((def) => {
                  const pick = draft.picks.find(p => p.nflTeam.id === def.id);
                  return (
                    <div 
                      key={def.id}
                      className={`p-5 rounded-3xl border transition-all flex items-center justify-between relative ${
                        pick 
                        ? 'bg-black/40 border-white/5 opacity-40 grayscale pointer-events-none' 
                        : 'bg-slate-900 border-white/10 hover:border-[#ee9c02]/60 hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(238,156,2,0.12)] group'
                      }`}
                    >
                      {pick && (
                        <span className="absolute top-2 right-3 text-[7px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-[#b81d0f]/80 text-white">DRAFTED</span>
                      )}
                      <div className="flex items-center gap-4">
                        <img 
                          src={`https://a.espncdn.com/i/teamlogos/nfl/500/${def.id.toLowerCase()}.png`} 
                          className="w-12 h-12 object-contain group-hover:scale-110 transition-transform" 
                          alt={def.name}
                        />
                        <div>
                          <div className="text-xs font-black uppercase text-white">{def.name}</div>
                          <div className="text-[9px] font-bold text-white uppercase tracking-tight">{def.id}</div>
                        </div>
                      </div>
                      {!pick && (isMyTurn || isAdmin) && (
                        <button 
                          onClick={() => makePick(def, !isMyTurn)}
                          className="bg-yellow-500 hover:bg-yellow-400 text-black px-5 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all active:scale-95"
                        >
                          Draft
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent Activity */}
            <aside className="bg-slate-900/50 border border-white/5 rounded-[2.5rem] p-8 h-fit lg:sticky lg:top-8">
              <h3 className="text-[11px] font-black uppercase text-white mb-8 border-b border-white/5 pb-4 tracking-widest flex items-center gap-2">
                <ChevronRight size={14} /> Feed
              </h3>
              <div className="space-y-6">
                {draft.picks.length === 0 ? (
                  <div className="text-center py-10 opacity-20">
                    <Trophy size={40} className="mx-auto mb-2" />
                    <div className="text-[10px] font-bold uppercase">No picks yet</div>
                  </div>
                ) : (
                  [...draft.picks].reverse().map((p, idx) => {
                    const fantasyTeamObj = TEAMS.find(t => t.name === p.fantasyTeam);
                    return (
                      <div key={idx} className="flex items-center gap-3 animate-in fade-in slide-in-from-right-4 duration-500">
                        {/* Pick number badge — left of logo, no overlap */}
                        <div className="flex-shrink-0 min-w-[28px] h-7 bg-orange-500 rounded-full flex items-center justify-center px-1.5">
                          <span className="text-[8px] font-black text-white leading-none">#{p.pickNumber}</span>
                        </div>
                        {/* NFL team logo */}
                        <img src={`https://a.espncdn.com/i/teamlogos/nfl/500/${p.nflTeam.id.toLowerCase()}.png`} className="w-10 h-10 flex-shrink-0" alt="" />
                        {/* Text info */}
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] font-black uppercase text-white truncate">{p.fantasyTeam}</div>
                          <div className="text-[8px] font-bold text-yellow-500 uppercase">{p.nflTeam.name}</div>
                        </div>
                        {/* ENL fantasy team logo */}
                        {fantasyTeamObj?.logo && (
                          <img src={fantasyTeamObj.logo} className="w-8 h-8 flex-shrink-0 rounded-full object-contain border border-white/10" alt={p.fantasyTeam} title={p.fantasyTeam} />
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          </div>
        )}

        {activeTab === 'board' && (
          <div className="bg-slate-900/50 border border-white/5 p-8 rounded-[2.5rem] overflow-x-auto scrollbar-hide">
            <div className="grid grid-cols-8 gap-4 min-w-[1000px]">
              {Array.from({ length: TOTAL_PICKS }).map((_, i) => {
                const pickNum = i + 1;
                const pick = draft.picks.find(p => p.pickNumber === pickNum);
                const assignedTeam = TEAMS.find(t => t.name === draft.pickMap[pickNum]);
                return (
                  <div 
                    key={pickNum}
                    className={`aspect-square rounded-3xl border-2 flex flex-col items-center justify-center p-4 relative overflow-hidden transition-all ${
                      pick 
                      ? 'bg-black/70 border-yellow-500/20' 
                      : pickNum === draft.currentPick 
                        ? 'bg-[#022240]/60 border-[#ee9c02] shadow-[0_0_18px_rgba(238,156,2,0.35)]'
                        : 'bg-[#022240]/30 border-white/20'
                    }`}
                  >
                    <span className="absolute top-3 left-4 text-[9px] font-black text-white" style={{ textShadow: "0 2px 10px rgba(0,0,0,0.75)" }}>#{pickNum}</span>
                    {/* Sweep overlay for current pick */}
                    {!pick && pickNum === draft.currentPick && (
                      <div className="animate-sweep pointer-events-none absolute inset-0" />
                    )}
                    {pick ? (
                      <>
                        <img src={`https://a.espncdn.com/i/teamlogos/nfl/500/${pick.nflTeam.id.toLowerCase()}.png`} className="w-14 h-14 mb-3 drop-shadow-[0_6px_16px_rgba(0,0,0,0.7)]" alt="" />
                        <div className="text-[8px] font-black uppercase text-center text-white line-clamp-1">{pick.fantasyTeam}</div>
                      </>
                    ) : (
                      <>
                        <img src={assignedTeam?.logo} className="w-8 h-8 opacity-90 mb-2 drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]" alt="" />
                        <div className="text-[9px] font-black uppercase text-center text-white tracking-wide line-clamp-2" style={{ textShadow: "0 2px 12px rgba(0,0,0,0.85)" }}>{assignedTeam?.name}</div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'admin' && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="bg-slate-900 border border-white/5 p-8 rounded-[2.5rem]">
               <h2 className="text-lg font-black uppercase italic text-yellow-500 mb-6 flex items-center gap-2">
                 <ArrowLeftRight size={20} /> Swap Draft Slots
               </h2>
               <div className="flex flex-col md:flex-row items-center gap-6">
                 <div className="flex-1 w-full">
                    <label className="text-[9px] font-black text-slate-500 uppercase mb-2 block">First Slot</label>
                    <select 
                      value={swapA} 
                      onChange={(e) => setSwapA(e.target.value)}
                      className="w-full bg-black border border-white/10 rounded-xl p-3 text-white text-xs outline-none focus:border-yellow-500"
                    >
                      <option value="">Select Pick #</option>
                      {Array.from({length: TOTAL_PICKS}, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>Pick #{n} ({draft.pickMap[n]})</option>
                      ))}
                    </select>
                 </div>
                 <div className="text-slate-500 pt-5"><ArrowLeftRight size={24} /></div>
                 <div className="flex-1 w-full">
                    <label className="text-[9px] font-black text-slate-500 uppercase mb-2 block">Second Slot</label>
                    <select 
                      value={swapB} 
                      onChange={(e) => setSwapB(e.target.value)}
                      className="w-full bg-black border border-white/10 rounded-xl p-3 text-white text-xs outline-none focus:border-yellow-500"
                    >
                      <option value="">Select Pick #</option>
                      {Array.from({length: TOTAL_PICKS}, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>Pick #{n} ({draft.pickMap[n]})</option>
                      ))}
                    </select>
                 </div>
                 <button 
                  onClick={swapDraftSlots}
                  className="bg-yellow-500 text-black font-black px-8 py-3 rounded-xl uppercase text-xs mt-0 md:mt-5 transition-transform active:scale-95"
                 >
                   Confirm Swap
                 </button>
               </div>
            </div>

            <div className="bg-slate-900 border border-white/5 p-10 rounded-[2.5rem] text-center">
              <h2 className="text-xl font-black uppercase italic text-white mb-8">System Maintenance</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button 
                  onClick={undoPick}
                  className="flex items-center justify-center gap-3 bg-slate-800 hover:bg-slate-700 text-white p-6 rounded-2xl text-xs font-black uppercase transition-all"
                >
                  <RotateCcw size={16} /> Undo Last Pick
                </button>
                <button 
                  onClick={resetBoard}
                  className="flex items-center justify-center gap-3 bg-red-900/20 hover:bg-red-900/40 text-red-500 p-6 rounded-2xl text-xs font-black uppercase border border-red-500/10 transition-all"
                >
                  <Lock size={16} /> Full Reset
                </button>
              </div>
            </div>

            {isAdmin && draft.currentPick <= TOTAL_PICKS && (
              <div className="bg-slate-900 border border-yellow-500/20 p-8 rounded-[2.5rem]">
                <h2 className="text-lg font-black uppercase italic text-yellow-500 mb-6 flex items-center gap-2">
                  <Clock size={20} /> Clock Override
                </h2>

                {draft.clockOverride?.pickNumber === draft.currentPick && (
                  <div className="text-xs text-slate-400 mb-5 bg-black/30 px-4 py-2 rounded-xl">
                    Override active — see main clock for current remaining
                  </div>
                )}

                <div className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-[9px] font-black text-slate-500 uppercase w-36">Set remaining (H:MM:SS)</label>
                    <input
                      value={overrideHms}
                      onChange={(e) => setOverrideHms(e.target.value)}
                      className="bg-black border border-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none focus:border-yellow-500 w-28 font-mono"
                      placeholder="1:00:00"
                    />
                    <button
                      onClick={() => {
                        const ms = parseHmsToMs(overrideHms);
                        if (ms === null) { alert('Invalid time — use H:MM:SS (e.g. 1:15:00)'); return; }
                        setClockOverrideRemainingMs(ms);
                      }}
                      className="bg-yellow-500 hover:bg-yellow-400 text-black font-black px-5 py-2 rounded-xl text-xs uppercase transition-all active:scale-95"
                    >
                      Apply
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-[9px] font-black text-slate-500 uppercase w-36">+/- minutes</label>
                    <input
                      type="number"
                      value={overrideMinutesDelta}
                      onChange={(e) => setOverrideMinutesDelta(Math.max(1, Number(e.target.value)))}
                      className="bg-black border border-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none focus:border-yellow-500 w-20"
                      min="1"
                    />
                    <button
                      onClick={() => {
                        const base = currentEffectiveRemainingMsRef.current;
                        setClockOverrideRemainingMs(base + overrideMinutesDelta * 60000);
                      }}
                      className="bg-slate-700 hover:bg-slate-600 text-white font-black px-5 py-2 rounded-xl text-xs uppercase transition-all active:scale-95"
                    >
                      +{overrideMinutesDelta}m
                    </button>
                    <button
                      onClick={() => {
                        const base = currentEffectiveRemainingMsRef.current;
                        setClockOverrideRemainingMs(base - overrideMinutesDelta * 60000);
                      }}
                      className="bg-slate-700 hover:bg-slate-600 text-white font-black px-5 py-2 rounded-xl text-xs uppercase transition-all active:scale-95"
                    >
                      -{overrideMinutesDelta}m
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
