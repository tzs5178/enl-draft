import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, updateDoc, arrayUnion } from 'firebase/firestore';
import { Trophy, Clock, Shield, RotateCcw, Lock, ChevronRight, ArrowLeftRight } from 'lucide-react';

// --- CONFIG ---
const LEAGUE_LOGO = "https://i.imgur.com/tz2WUcI.png";
const ADMIN_TEAM_NAME = "The Sassy Boys";
const TEAMS_COUNT = 8;
const TOTAL_PICKS = 16;
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1494020176075689986/WEDJVhqheH9aY8VxWBr75s7H1HzOiNK-W_thu1XQ_elUmNqbrs7z6pJNogJsdVuME8G8";

const TEAMS = [
  { name: "The Golden Path", logo: "https://i.imgur.com/F4wgHz7.png", passcode: "3863" },
  { name: "Hinkie Sinkie", logo: "https://i.imgur.com/aiOnSde.png", passcode: "5280" },
  { name: "The Sassy Boys", logo: "https://i.imgur.com/mDVtQsn.png", passcode: "7366" },
  { name: "Eternal Beans", logo: "https://i.imgur.com/0JY0Tsr.png", passcode: "2326" },
  { name: "FantaCTE Fooseball Team", logo: "https://i.imgur.com/wb9CZsl.png", passcode: "0420" },
  { name: "New England Patriots", logo: "https://i.imgur.com/LKwLUM5.png", passcode: "2803" },
  { name: "Richmond Rebels", logo: "https://i.imgur.com/hDpWB15.png", passcode: "2116" },
  { name: "This is your team on CTE", logo: "https://i.imgur.com/j4BaAQm.png", passcode: "0302" }
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

  // Timer Effect
  useEffect(() => {
    if (!draft || draft.currentPick > TOTAL_PICKS) return;
    const interval = setInterval(() => {
      const deadline = draft.lastPickTime + (12 * 3600000); // 12h window
      const diff = deadline - Date.now();
      if (diff <= 0) {
        setTimeLeft("00:00");
      } else {
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        setTimeLeft(`${hours}h ${mins}m`);
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
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');

    try {
      await updateDoc(docRef, {
        picks: arrayUnion({ pickNumber: pNum, fantasyTeam, nflTeam }),
        currentPick: pNum + 1,
        lastPickTime: Date.now()
      });

      if (DISCORD_WEBHOOK) {
        fetch(DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `📢 **${fantasyTeam}** has drafted the **${nflTeam.name}**!`
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
    const teamA = newPickMap[swapA];
    const teamB = newPickMap[swapB];

    newPickMap[swapA] = teamB;
    newPickMap[swapB] = teamA;

    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'sessions', 'draft_session');
    try {
      await updateDoc(docRef, { pickMap: newPickMap });
      setSwapA('');
      setSwapB('');
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center bg-slate-900/50 p-6 rounded-[2.5rem] border border-white/5 mb-8 gap-6">
          <div className="flex items-center gap-4">
            <img src={LEAGUE_LOGO} className="w-12 h-12" alt="ENL" />
            <div>
              <h1 className="text-xl font-black italic uppercase tracking-tighter">ENL D/ST Draft</h1>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span className="text-[8px] uppercase text-slate-500 font-bold">Live System v2.0</span>
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
                    activeTab === tab ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/20' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab}
                </button>
              )
            ))}
          </nav>

          <button 
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            className="text-[8px] font-black uppercase text-slate-700 hover:text-red-500 transition-colors"
          >
            Logout
          </button>
        </header>

        {/* Views */}
        {activeTab === 'draft' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
              {/* OTC Status */}
              <div className="bg-slate-900 border border-white/5 rounded-[2.5rem] p-8 mb-8 flex flex-col md:flex-row justify-between items-center relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none"><Trophy size={100} /></div>
                <div>
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2">
                    <Shield size={12} className="text-yellow-500" /> Currently Picking
                  </div>
                  <div className="text-3xl font-black italic uppercase text-yellow-500 truncate max-w-md">
                    {otcName || "DRAFT COMPLETE"}
                  </div>
                </div>
                <div className="flex items-center gap-3 bg-black/40 px-6 py-4 rounded-3xl border border-white/5 mt-6 md:mt-0">
                  <Clock size={20} className="text-slate-500" />
                  <span className="text-2xl font-black font-mono text-slate-300 tracking-tighter">{timeLeft}</span>
                </div>
              </div>

              {/* Pool */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {DEFENSES.map((def) => {
                  const pick = draft.picks.find(p => p.nflTeam.id === def.id);
                  return (
                    <div 
                      key={def.id}
                      className={`p-5 rounded-3xl border transition-all flex items-center justify-between ${
                        pick 
                        ? 'bg-black/40 border-white/5 opacity-30 grayscale pointer-events-none' 
                        : 'bg-slate-900 border-white/10 hover:border-yellow-500/50 group'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <img 
                          src={`https://a.espncdn.com/i/teamlogos/nfl/500/${def.id.toLowerCase()}.png`} 
                          className="w-12 h-12 object-contain group-hover:scale-110 transition-transform" 
                          alt={def.name}
                        />
                        <div>
                          <div className="text-xs font-black uppercase text-slate-200">{def.name}</div>
                          <div className="text-[9px] font-bold text-slate-500 uppercase tracking-tight">{def.id}</div>
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
              <h3 className="text-[11px] font-black uppercase text-slate-500 mb-8 border-b border-white/5 pb-4 tracking-widest flex items-center gap-2">
                <ChevronRight size={14} /> Feed
              </h3>
              <div className="space-y-6">
                {draft.picks.length === 0 ? (
                  <div className="text-center py-10 opacity-20">
                    <Trophy size={40} className="mx-auto mb-2" />
                    <div className="text-[10px] font-bold uppercase">No picks yet</div>
                  </div>
                ) : (
                  [...draft.picks].reverse().map((p, idx) => (
                    <div key={idx} className="flex items-center gap-4 animate-in fade-in slide-in-from-right-4 duration-500">
                      <div className="relative">
                        <img src={`https://a.espncdn.com/i/teamlogos/nfl/500/${p.nflTeam.id.toLowerCase()}.png`} className="w-10 h-10" alt="" />
                        <div className="absolute -top-1 -left-1 bg-yellow-500 text-black text-[7px] font-black px-1 rounded-sm">#{p.pickNumber}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[10px] font-black uppercase text-white truncate">{p.fantasyTeam}</div>
                        <div className="text-[8px] font-bold text-yellow-500 uppercase">{p.nflTeam.name}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          </div>
        )}

        {activeTab === 'board' && (
          <div className="bg-slate-900 border border-white/5 p-8 rounded-[2.5rem] overflow-x-auto scrollbar-hide">
            <div className="grid grid-cols-8 gap-4 min-w-[1000px]">
              {Array.from({ length: TOTAL_PICKS }).map((_, i) => {
                const pickNum = i + 1;
                const pick = draft.picks.find(p => p.pickNumber === pickNum);
                const assignedTeam = TEAMS.find(t => t.name === draft.pickMap[pickNum]);
                return (
                  <div 
                    key={pickNum}
                    className={`aspect-square rounded-3xl border-2 flex flex-col items-center justify-center p-4 relative transition-all ${
                      pick 
                      ? 'bg-black border-yellow-500/20' 
                      : pickNum === draft.currentPick 
                        ? 'bg-yellow-500/5 border-yellow-500/50 animate-pulse'
                        : 'bg-slate-950 border-white/5 opacity-40'
                    }`}
                  >
                    <span className="absolute top-3 left-4 text-[9px] font-black text-slate-700">#{pickNum}</span>
                    {pick ? (
                      <>
                        <img src={`https://a.espncdn.com/i/teamlogos/nfl/500/${pick.nflTeam.id.toLowerCase()}.png`} className="w-14 h-14 mb-3" alt="" />
                        <div className="text-[8px] font-black uppercase text-center text-white line-clamp-1">{pick.fantasyTeam}</div>
                      </>
                    ) : (
                      <>
                        <img src={assignedTeam?.logo} className="w-8 h-8 opacity-20 grayscale mb-2" alt="" />
                        <div className="text-[7px] font-black uppercase text-center text-slate-700 line-clamp-1">{assignedTeam?.name}</div>
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
                 <div className="text-slate-700 pt-5"><ArrowLeftRight size={24} /></div>
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
                  className="flex items-center justify-center gap-3 bg-slate-800 hover:bg-slate-700 p-6 rounded-2xl text-xs font-black uppercase transition-all"
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
          </div>
        )}
      </div>
    </div>
  );
}
