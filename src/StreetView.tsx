import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase'; 
import GuessMap from './GuessMap';

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
if (API_KEY) {
  setOptions({ key: API_KEY, v: 'weekly' });
}

type GameState = 'PROFILE_SETUP' | 'START' | 'MP_MENU' | 'CREATE_LOBBY' | 'JOIN_LOBBY' | 'LOBBY' | 'PLAYING' | 'ROUND_OVER' | 'GAME_OVER';

interface Player {
  id: string;
  name: string;
  avatarSeed: string;
  isHost: boolean;
  score: number;
  currentGuess: { lat: number, lng: number } | null;
  distance: number | null;
  pointsEarned: number | null;
}

export default function StreetView() {
  const mapRef = useRef<HTMLDivElement>(null);
  const panoInstance = useRef<any>(null);
  const googleServiceRef = useRef<any>(null);
  
  const [gameState, setGameState] = useState<GameState>('PROFILE_SETUP');
  const [isWarping, setIsWarping] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ status: 'INITIALIZING...' });
  
  const [currentGuess, setCurrentGuess] = useState<{lat: number, lng: number} | null>(null);
  const [actualLocation, setActualLocation] = useState<{lat: number, lng: number} | null>(null);
  const [roundKey, setRoundKey] = useState(0);

  const [nextQueuedLocation, setNextQueuedLocation] = useState<{lat: number, lng: number} | null>(null);
  const isPrefetchingRef = useRef(false);

  const [playerName, setPlayerName] = useState('');
  const [avatarSeed, setAvatarSeed] = useState(() => Math.random().toString(36).substring(2, 9));
  const [playerId] = useState(() => Math.random().toString(36).substring(2, 9)); 

  const [lobbyCode, setLobbyCode] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [lobbyData, setLobbyData] = useState<any>(null);

  const [settings, setSettings] = useState({ roundTime: 60, fastTimer: 15, maxRounds: 5, pointsToWin: 0, elimination: false });
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  
  const [spEndTime, setSpEndTime] = useState<number | null>(null);
  const [spScore, setSpScore] = useState(0);
  const [spRound, setSpRound] = useState(0);
  const [spResult, setSpResult] = useState<{points: number, distance: number, timeout: boolean} | null>(null);

  const [flashActive, setFlashActive] = useState(false);
  const prevGuessesCount = useRef(0);

  const findValidLocation = async (): Promise<{lat: number, lng: number} | null> => {
    if (!googleServiceRef.current) return null;
    let attempts = 0;
    while (attempts < 50) {
      attempts++;
      const lat = (Math.random() * 140) - 70; const lng = (Math.random() * 360) - 180;
      try {
        const response = await googleServiceRef.current.getPanorama({ location: { lat, lng }, radius: 50000, source: 'outdoor' as any });
        if (response?.data && response.data.copyright?.includes('Google') && response.data.links?.length) {
          return { lat: response.data.location.latLng.lat(), lng: response.data.location.latLng.lng() };
        }
      } catch (e) { /* Ignore */ }
      await new Promise(res => setTimeout(res, 250));
    }
    return null;
  };

  useEffect(() => {
    let isMounted = true;
    const init = async () => {
      try {
        const { StreetViewPanorama, StreetViewService } = await importLibrary('streetView') as any;
        if (!isMounted) return;
        googleServiceRef.current = new StreetViewService();
        if (mapRef.current && !panoInstance.current) {
          panoInstance.current = new StreetViewPanorama(mapRef.current, {
            position: { lat: 48.8738, lng: 2.2950 }, zoom: 1, visible: true, source: 'outdoor' as any,
            addressControl: false, showRoadLabels: false, motionTracking: false, motionTrackingControl: false
          });
        }
        if (!isPrefetchingRef.current && !nextQueuedLocation) {
          isPrefetchingRef.current = true;
          const loc = await findValidLocation();
          if (loc && isMounted) setNextQueuedLocation(loc);
          isPrefetchingRef.current = false;
        }
      } catch (err) { console.error(err); }
    };
    setTimeout(init, 500);
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (!lobbyCode) return;
    const unsub = onSnapshot(doc(db, 'lobbies', lobbyCode), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        
        if (data.status === 'PLAYING' && data.currentRound !== roundKey) {
           setRoundKey(data.currentRound); 
           if (!isHost) executeWarp(data.targetLocation);
        }
        if (data.status === 'ROUND_OVER' && gameState !== 'ROUND_OVER') {
          setGameState('ROUND_OVER'); setActualLocation(data.targetLocation);
        }
        if (data.status === 'GAME_OVER' && gameState !== 'GAME_OVER') {
          setGameState('GAME_OVER'); setActualLocation(data.targetLocation);
        }
      }
    });
    return () => unsub(); 
  }, [lobbyCode, isHost, gameState, roundKey]);

  useEffect(() => {
    if (gameState !== 'PLAYING') {
      prevGuessesCount.current = 0;
      return;
    }
    const currentGuesses = lobbyCode && lobbyData ? lobbyData.players.filter((p:Player)=>p.currentGuess).length : 0;
    if (currentGuesses > 0 && prevGuessesCount.current === 0) {
        setFlashActive(true);
        setTimeout(() => setFlashActive(false), 1500);
    }
    prevGuessesCount.current = currentGuesses;
  }, [lobbyData, gameState, lobbyCode]);

  useEffect(() => {
    if (isHost && gameState === 'PLAYING' && lobbyCode && lobbyData) {
      if (lobbyData.currentRound !== roundKey) return; 
      const guessesCount = lobbyData.players.filter((p: Player) => p.currentGuess).length;
      if (guessesCount > 0 && guessesCount === lobbyData.players.length) {
        endRound(lobbyData);
      }
    }
  }, [lobbyData, isHost, gameState, roundKey]);

  useEffect(() => {
    if (gameState !== 'PLAYING') { setTimeLeft(null); return; }
    if (lobbyCode && lobbyData && lobbyData.currentRound !== roundKey) return;

    const targetEndTime = lobbyCode ? lobbyData?.roundEndTime : spEndTime;
    if (targetEndTime) {
      const interval = setInterval(() => {
        const remaining = Math.max(0, Math.floor((targetEndTime - Date.now()) / 1000));
        setTimeLeft(remaining);
        if (remaining <= 0) {
          if (lobbyCode && isHost) endRound(lobbyData);
          else if (!lobbyCode) { setSpResult({ points: 0, distance: 0, timeout: true }); setGameState('ROUND_OVER'); }
        }
      }, 500);
      return () => clearInterval(interval);
    }
  }, [gameState, lobbyData, isHost, lobbyCode, spEndTime, roundKey]);

  const executeWarp = (pos: {lat: number, lng: number}) => {
    setIsWarping(true); setGameState('PLAYING'); setCurrentGuess(null);
    panoInstance.current.setPosition(pos); panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
    setDiagnostics({ status: 'TARGET LOCKED.' });
    setTimeout(() => setIsWarping(false), 800);
  };

  const handleChaosWarp = async () => {
    if (!googleServiceRef.current || !panoInstance.current) return;
    
    setIsWarping(true); 
    let pos = nextQueuedLocation;

    if (!pos) {
      setDiagnostics({ status: 'SEARCHING SIGNAL...' });
      pos = await findValidLocation();
    }

    if (pos) {
      setNextQueuedLocation(null); 
      panoInstance.current.setPosition(pos); setActualLocation(pos);
      panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
      
      if (lobbyCode && isHost && lobbyData) {
        const newRound = (lobbyData.currentRound || 0) + 1;
        const resetPlayers = lobbyData.players.map((p: Player) => ({ ...p, currentGuess: null, distance: null, pointsEarned: null }));
        
        setRoundKey(newRound);
        setGameState('PLAYING');
        setCurrentGuess(null);

        await updateDoc(doc(db, 'lobbies', lobbyCode), {
          status: 'PLAYING', targetLocation: pos, roundEndTime: Date.now() + (lobbyData.settings.roundTime * 1000),
          currentRound: newRound, players: resetPlayers
        });
      } else if (!lobbyCode) {
        setRoundKey(prev => prev + 1);
        setGameState('PLAYING');
        setCurrentGuess(null);
        setSpEndTime(Date.now() + (180 * 1000)); setSpRound(prev => prev + 1); setSpResult(null);
      }

      setDiagnostics({ status: 'TARGET LOCKED.' });
      setTimeout(() => setIsWarping(false), 800);

      if (!isPrefetchingRef.current) {
         isPrefetchingRef.current = true;
         findValidLocation().then(newLoc => {
            if (newLoc) setNextQueuedLocation(newLoc);
            isPrefetchingRef.current = false;
         });
      }
    } else {
      setDiagnostics({ status: 'WARP FAILED. TRY AGAIN.' });
      setTimeout(() => setIsWarping(false), 1500);
    }
  };

  const calculateDistance = (p1: any, p2: any) => {
    const R = 6371; const dLat = (p2.lat - p1.lat) * Math.PI / 180; const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  };

  const submitGuess = async () => {
    if (!currentGuess || gameState !== 'PLAYING') return;

    if (lobbyCode && lobbyData) {
      const updatedPlayers = lobbyData.players.map((p: Player) => p.id === playerId ? { ...p, currentGuess } : p);
      let newEndTime = lobbyData.roundEndTime;
      const guessesCount = updatedPlayers.filter((p: Player) => p.currentGuess).length;

      if (guessesCount === 1 && lobbyData.settings.fastTimer > 0) {
        const potentialEnd = Date.now() + (lobbyData.settings.fastTimer * 1000);
        if (potentialEnd < newEndTime) newEndTime = potentialEnd;
      }
      await updateDoc(doc(db, 'lobbies', lobbyCode), { players: updatedPlayers, roundEndTime: newEndTime });
    } else {
      if (!actualLocation) return;
      const dist = calculateDistance(currentGuess, actualLocation);
      const pts = Math.max(0, Math.round(5000 * Math.exp(-dist / 2000)));
      setSpScore(prev => prev + pts); setSpResult({ points: pts, distance: dist, timeout: false });
      setGameState('ROUND_OVER');
    }
  };

  const endRound = async (currentData: any) => {
    if (!isHost) return;
    const scoredPlayers = currentData.players.map((p: Player) => {
      let pts = 0, dist = null;
      if (p.currentGuess && currentData.targetLocation) {
        dist = calculateDistance(p.currentGuess, currentData.targetLocation);
        pts = Math.max(0, Math.round(5000 * Math.exp(-dist / 2000)));
      }
      return { ...p, distance: dist, pointsEarned: pts, score: (p.score || 0) + pts };
    }).sort((a: Player, b: Player) => b.score - a.score);

    const isMax = currentData.currentRound >= currentData.settings.maxRounds;
    const isWin = currentData.settings.pointsToWin > 0 && scoredPlayers.some((p: Player) => p.score >= currentData.settings.pointsToWin);
    
    if (currentData.settings.elimination && scoredPlayers.length > 1) { scoredPlayers[scoredPlayers.length - 1].name += " [ELIMINATED]"; }

    await updateDoc(doc(db, 'lobbies', lobbyCode), { status: (isMax || isWin) ? 'GAME_OVER' : 'ROUND_OVER', players: scoredPlayers });
  };

  const handleCreateLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    const newCode = Math.floor(10000 + Math.random() * 90000).toString();
    const newPlayer = { id: playerId, name: playerName, avatarSeed, isHost: true, score: 0, currentGuess: null, distance: null, pointsEarned: null };
    await setDoc(doc(db, 'lobbies', newCode), { status: 'LOBBY', targetLocation: null, players: [newPlayer], settings, currentRound: 0 });
    setLobbyCode(newCode); setIsHost(true); setGameState('LOBBY');
  };

  const handleJoinLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCodeInput.length !== 5) return;
    const lobbyRef = doc(db, 'lobbies', joinCodeInput);
    const lobbySnap = await getDoc(lobbyRef);

    if (lobbySnap.exists()) {
      const data = lobbySnap.data();
      if (data.players.length >= 8) return alert("Lobby full!");
      if (data.status !== 'LOBBY') return alert("Game in progress!");
      const newPlayer = { id: playerId, name: playerName, avatarSeed, isHost: false, score: 0, currentGuess: null, distance: null, pointsEarned: null };
      await updateDoc(lobbyRef, { players: [...data.players, newPlayer] });
      setLobbyCode(joinCodeInput); setIsHost(false); setGameState('LOBBY');
    } else alert("Lobby not found.");
  };

  const returnHome = () => { setGameState('START'); setLobbyCode(''); setSpScore(0); setSpRound(0); setSpEndTime(null); };

  // THE FIX: Strict Guard so the host is never locked in by stale Firebase data
  const isLockedIn = lobbyCode && lobbyData?.currentRound === roundKey
    ? !!lobbyData?.players.find((p:Player)=>p.id===playerId)?.currentGuess 
    : false;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && currentGuess && gameState === 'PLAYING' && !isLockedIn) { e.preventDefault(); submitGuess(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentGuess, gameState, submitGuess, isLockedIn]);

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      
      <style>{`
        @keyframes radar-scan { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .radar-box { position: relative; width: 100px; height: 100px; border-radius: 50%; border: 1px solid #00ff41; margin-bottom: 30px; background: linear-gradient(90deg, transparent 49%, rgba(0, 255, 65, 0.4) 50%, transparent 51%), linear-gradient(0deg, transparent 49%, rgba(0, 255, 65, 0.4) 50%, transparent 51%); box-shadow: 0 0 20px rgba(0,255,65,0.2), inset 0 0 20px rgba(0,255,65,0.2); overflow: hidden; }
        .radar-beam { position: absolute; top: 0; left: 0; width: 50%; height: 50%; background: conic-gradient(from 180deg at 100% 100%, transparent 0deg, rgba(0, 255, 65, 0.8) 90deg); transform-origin: 100% 100%; animation: radar-scan 1.5s linear infinite; }
        .radar-dot { position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; background: #fff; border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 10px #fff, 0 0 20px #00ff41; }
        
        @keyframes damage-flash {
          0% { box-shadow: inset 0 0 0px rgba(255, 0, 60, 0); background-color: rgba(255, 0, 60, 0); }
          10% { box-shadow: inset 0 0 150px rgba(255, 0, 60, 0.8); background-color: rgba(255, 0, 60, 0.2); }
          100% { box-shadow: inset 0 0 0px rgba(255, 0, 60, 0); background-color: rgba(255, 0, 60, 0); }
        }
        .damage-overlay { position: absolute; inset: 0; z-index: 3900; pointer-events: none; animation: damage-flash 1.5s ease-out forwards; }
        
        @keyframes timer-pulse-big {
          0% { transform: scale(1); }
          10% { transform: scale(2.5); color: #ff003c; text-shadow: 0 0 30px #ff003c; }
          100% { transform: scale(1); color: #ff003c; }
        }
        .timer-flash { animation: timer-pulse-big 1.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
      `}</style>

      {flashActive && <div className="damage-overlay"></div>}

      {!['PROFILE_SETUP', 'START', 'MP_MENU', 'CREATE_LOBBY', 'JOIN_LOBBY'].includes(gameState) && !isWarping && (
        <button onClick={returnHome} style={{...buttonStyle, position: 'absolute', top: '10px', left: '10px', zIndex: 4500, padding: '10px', width: 'auto'}}>← HOME</button>
      )}

      <div ref={mapRef} style={{ width: '100%', height: '100%', position: 'absolute', opacity: (['PROFILE_SETUP', 'START', 'MP_MENU', 'CREATE_LOBBY', 'JOIN_LOBBY', 'LOBBY', 'ROUND_OVER', 'GAME_OVER'].includes(gameState) || isWarping) ? 0 : 1, transition: 'opacity 0.6s ease' }} />

      <div style={{ position: 'absolute', inset: 0, zIndex: 4000, backgroundColor: '#000', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', transition: 'opacity 0.4s', opacity: isWarping ? 1 : 0, pointerEvents: isWarping ? 'all' : 'none' }}>
        <div className="radar-box"><div className="radar-beam"></div><div className="radar-dot"></div></div>
        <div style={{ color: '#00ff41', fontFamily: 'monospace', fontSize: '2rem', letterSpacing: '8px' }}>WARPING...</div>
        <div style={{ color: '#00ff41', opacity: 0.6, marginTop: '20px', fontFamily: 'monospace', textAlign: 'center' }}>{diagnostics.status}</div>
      </div>

      {gameState === 'PLAYING' && (
        <div style={{ position: 'absolute', top: '20px', right: '20px', zIndex: 3500, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px', pointerEvents: 'none' }}>
           {timeLeft !== null && (
             <div className={flashActive ? 'timer-flash' : ''} style={{ transformOrigin: 'top right' }}>
               <div style={{ fontSize: '2rem', fontWeight: 'bold', color: timeLeft <= 15 ? '#ff003c' : '#fff', textShadow: `0 0 10px ${timeLeft <= 15 ? '#ff003c' : '#00ff41'}`, fontFamily: 'monospace', background: 'rgba(0,0,0,0.8)', padding: '5px 15px', border: `1px solid ${timeLeft <= 15 ? '#ff003c' : '#00ff41'}`, borderRadius: '4px' }}>
                 00:{timeLeft.toString().padStart(2, '0')}
               </div>
             </div>
           )}

           {lobbyCode ? (
             <div style={{ background: 'rgba(0,0,0,0.8)', padding: '10px', border: '1px solid #00ff41', fontFamily: 'monospace', borderRadius: '4px' }}>
               {lobbyData?.players.map((p: Player) => <div key={p.id} style={{ color: p.currentGuess ? '#00ff41' : '#fff', margin: '5px 0' }}>{p.currentGuess ? '✅' : '⏳'} {p.name}</div>)}
             </div>
           ) : (
             <div style={{ background: 'rgba(0,0,0,0.8)', padding: '10px', border: '1px solid #00ff41', color: '#00ff41', fontFamily: 'monospace', borderRadius: '4px' }}>
                SCORE: {spScore} <br/><span style={{opacity: 0.7, fontSize: '0.8rem'}}>ROUND {spRound}</span>
             </div>
           )}
        </div>
      )}

      {/* THE FIX: Unified permanent GuessMap that never unmounts! */}
      {['PLAYING', 'ROUND_OVER', 'GAME_OVER'].includes(gameState) && (
        <GuessMap 
          onGuessSelected={setCurrentGuess} 
          actualLocation={gameState !== 'PLAYING' ? actualLocation : null} 
          allGuesses={gameState === 'PLAYING' ? [] : (lobbyCode && lobbyData ? lobbyData.players : (currentGuess ? [{name: playerName, avatarSeed, currentGuess}] : []))} 
          roundKey={roundKey} 
          isLockedIn={isLockedIn} 
        />
      )}

      {gameState === 'PLAYING' && (
        <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 3500, display: 'flex', width: '90%', maxWidth: '300px' }}>
           {lobbyCode ? (
             <button onClick={submitGuess} disabled={!currentGuess || isLockedIn} style={{...actionButtonStyle(!!currentGuess && !isLockedIn), width: '100%', backgroundColor: isLockedIn ? '#00ff41' : '#000', color: isLockedIn ? '#000' : '#00ff41'}}>
               {isLockedIn ? 'WAITING FOR PLAYERS...' : 'LOCK GUESS'}
             </button>
           ) : (
             <button onClick={submitGuess} disabled={!currentGuess} style={{...actionButtonStyle(!!currentGuess), width: '100%'}}>LOCK GUESS [SPACE]</button>
           )}
        </div>
      )}

      {gameState === 'ROUND_OVER' && !lobbyCode && spResult && (
        <div style={resultOverlayStyle}>
          <div style={{ fontSize: '1.2rem', marginBottom: '15px', borderBottom: '1px solid #00ff41', paddingBottom: '5px' }}>{spResult.timeout ? 'SIGNAL LOST' : 'MISSION COMPLETE'}</div>
          {spResult.timeout ? (
            <div style={{ fontSize: '1.5rem', color: '#ff003c', margin: '20px 0' }}>TARGET NOT LOCATED IN TIME</div>
          ) : (
            <>
              <div style={{ fontSize: '3rem', fontWeight: 'bold', color: '#fff', textShadow: '0 0 20px #00ff41' }}>{spResult.points} <span style={{ fontSize: '1.5rem', opacity: 0.7 }}>PTS</span></div>
              <div style={{ fontSize: '1.5rem', color: '#00ff41', marginTop: '10px' }}>{spResult.distance < 1 ? `${(spResult.distance * 1000).toFixed(0)} meters` : `${spResult.distance.toFixed(1)} km`}</div>
            </>
          )}
          <button onClick={handleChaosWarp} style={{...actionButtonStyle(true), marginTop: '20px'}}>NEXT ROUND</button>
        </div>
      )}

      {['ROUND_OVER', 'GAME_OVER'].includes(gameState) && lobbyCode && lobbyData && (
        <div style={resultOverlayStyle}>
          <h2 style={{ color: gameState === 'GAME_OVER' ? '#ffd700' : '#00ff41', margin: '0 0 15px 0' }}>{gameState === 'GAME_OVER' ? 'GAME COMPLETE' : `ROUND ${lobbyData.currentRound} COMPLETE`}</h2>
          <div style={{ textAlign: 'left', borderTop: '1px solid #444' }}>
            {lobbyData.players.map((p: Player, i: number) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #444' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                   <span style={{ fontWeight: 'bold', width: '20px' }}>{i + 1}.</span>
                   <img src={`https://api.dicebear.com/8.x/bottts/svg?seed=${p.avatarSeed}`} alt="avatar" style={{width: '35px', height: '35px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)'}} />
                   <span style={{ fontWeight: 'bold' }}>{p.name}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#00ff41', fontWeight: 'bold', fontSize: '1.2rem' }}>{p.score}</div>
                  <div style={{ color: '#aaa', fontSize: '0.8rem' }}>+{p.pointsEarned || 0}</div>
                </div>
              </div>
            ))}
          </div>
          {isHost ? (
             <button onClick={gameState === 'GAME_OVER' ? returnHome : handleChaosWarp} style={{...actionButtonStyle(true), marginTop: '20px'}}>{gameState === 'GAME_OVER' ? 'END GAME' : 'NEXT ROUND'}</button>
          ) : <div style={{ color: '#888', marginTop: '20px' }}>WAITING FOR HOST...</div>}
        </div>
      )}

      {gameState === 'PROFILE_SETUP' && (
        <div style={menuContainerStyle}>
          <h1 style={titleStyle}>GEOBATTLE</h1>
          <div style={{ color: '#00ff41', opacity: 0.7, marginBottom: '20px', fontFamily: 'monospace' }}>AGENT INITIALIZATION</div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '15px', marginBottom: '30px' }}>
            <div style={{ width: '120px', height: '120px', border: '2px solid #00ff41', borderRadius: '50%', backgroundColor: 'rgba(0,255,65,0.1)', overflow: 'hidden', padding: '10px' }}>
              <img src={`https://api.dicebear.com/8.x/bottts/svg?seed=${avatarSeed}`} alt="Avatar" style={{ width: '100%', height: '100%' }} />
            </div>
            <button type="button" onClick={() => setAvatarSeed(Math.random().toString(36).substring(2, 9))} style={{ ...buttonStyle, padding: '5px 15px', fontSize: '0.8rem', width: 'auto' }}>[ RE-ROLL AVATAR ]</button>
          </div>
          <input autoFocus placeholder="ENTER CALLSIGN" value={playerName} onChange={(e) => setPlayerName(e.target.value.toLowerCase())} style={{ ...inputStyle, textAlign: 'center', fontSize: '1.5rem', letterSpacing: '2px' }} maxLength={15} />
          <button onClick={() => setGameState('START')} disabled={!playerName.trim()} style={actionButtonStyle(!!playerName.trim())}>ACCESS TERMINAL</button>
        </div>
      )}

      {gameState === 'START' && (
        <div style={landingStyle}>
          <h1 style={titleStyle}>GEOBATTLE</h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', width: '90%', maxWidth: '300px', marginTop: '20px' }}>
            <button onClick={handleChaosWarp} style={buttonStyle}>SINGLE PLAYER</button>
            <button onClick={() => setGameState('MP_MENU')} style={buttonStyle}>MULTI PLAYER</button>
          </div>
        </div>
      )}

      {gameState === 'MP_MENU' && (
        <div style={menuContainerStyle}>
          <h2 style={subtitleStyle}>MULTIPLAYER</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', width: '90%', maxWidth: '300px' }}>
            <button onClick={() => setGameState('CREATE_LOBBY')} style={buttonStyle}>CREATE LOBBY</button>
            <button onClick={() => setGameState('JOIN_LOBBY')} style={buttonStyle}>JOIN LOBBY</button>
            <button onClick={() => setGameState('START')} style={{ ...buttonStyle, borderColor: '#444', color: '#888' }}>BACK</button>
          </div>
        </div>
      )}

      {gameState === 'CREATE_LOBBY' && (
        <form onSubmit={handleCreateLobby} style={{...menuContainerStyle, overflowY: 'auto', padding: '20px 0'}}>
          <h2 style={subtitleStyle}>LOBBY SETTINGS</h2>
          <div style={{display: 'flex', flexDirection: 'column', gap: '10px', width: '90%', maxWidth: '300px', textAlign: 'left', color: '#aaa', fontSize: '0.8rem'}}>
             <label>ROUND TIME (SEC) <input type="number" value={settings.roundTime} onChange={e=>setSettings({...settings, roundTime: Number(e.target.value)})} style={{...inputStyle, padding: '5px'}}/></label>
             <label>FAST TIMER (SEC) <input type="number" value={settings.fastTimer} onChange={e=>setSettings({...settings, fastTimer: Number(e.target.value)})} style={{...inputStyle, padding: '5px'}}/></label>
             <label>MAX ROUNDS <input type="number" value={settings.maxRounds} onChange={e=>setSettings({...settings, maxRounds: Number(e.target.value)})} max="10" style={{...inputStyle, padding: '5px'}}/></label>
             <label>POINTS TO WIN (0 = OFF) <input type="number" value={settings.pointsToWin} onChange={e=>setSettings({...settings, pointsToWin: Number(e.target.value)})} style={{...inputStyle, padding: '5px'}}/></label>
             <label style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>ELIMINATION MODE <input type="checkbox" checked={settings.elimination} onChange={e=>setSettings({...settings, elimination: e.target.checked})}/></label>
          </div>
          <button type="submit" style={actionButtonStyle(true)}>GENERATE</button>
          <button type="button" onClick={() => setGameState('MP_MENU')} style={{ ...buttonStyle, border: 'none' }}>BACK</button>
        </form>
      )}

      {gameState === 'JOIN_LOBBY' && (
        <form onSubmit={handleJoinLobby} style={menuContainerStyle}>
          <h2 style={subtitleStyle}>JOIN UPLINK</h2>
          <input autoFocus placeholder="5-DIGIT CODE" value={joinCodeInput} onChange={(e) => setJoinCodeInput(e.target.value.replace(/\D/g, '').slice(0, 5))} style={{ ...inputStyle, textAlign: 'center', letterSpacing: '10px', fontSize: '1.5rem' }} />
          <button type="submit" disabled={joinCodeInput.length !== 5} style={actionButtonStyle(joinCodeInput.length === 5)}>CONNECT</button>
          <button type="button" onClick={() => setGameState('MP_MENU')} style={{ ...buttonStyle, border: 'none' }}>BACK</button>
        </form>
      )}

      {gameState === 'LOBBY' && (
        <div style={menuContainerStyle}>
          <h2 style={subtitleStyle}>CODE: {lobbyCode}</h2>
          <div style={{ color: '#00ff41', opacity: 0.7 }}>PLAYERS ({lobbyData?.players?.length || 0}/8)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '90%', maxWidth: '300px', marginBottom: '20px' }}>
            {lobbyData?.players.map((p: Player) => (
              <div key={p.id} style={{ padding: '10px', border: '1px solid #00ff41', background: 'rgba(0,255,65,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <img src={`https://api.dicebear.com/8.x/bottts/svg?seed=${p.avatarSeed}`} alt="avatar" style={{width: '30px', height: '30px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)'}} />
                  <span>{p.name}</span>
                </div>
                {p.isHost && <span style={{fontSize:'0.8rem', opacity:0.7}}>[HOST]</span>}
              </div>
            ))}
          </div>
          {isHost ? <button onClick={handleChaosWarp} style={actionButtonStyle(true)}>START GAME</button> : <div style={{ padding: '15px', color: '#888', border: '1px solid #444' }}>WAITING FOR HOST...</div>}
        </div>
      )}
      
    </div>
  );
}

// --- Responsive Styles ---
const landingStyle: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 4500, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 1)', color: '#00ff41', textAlign: 'center', padding: '20px', boxSizing: 'border-box' };
const menuContainerStyle: React.CSSProperties = { ...landingStyle, backgroundColor: 'rgba(0,0,0,0.95)' };
const titleStyle: React.CSSProperties = { fontSize: 'clamp(2.5rem, 8vw, 4rem)', margin: 0, letterSpacing: '0.25em', fontFamily: '"Outfit", monospace' };
const subtitleStyle: React.CSSProperties = { fontSize: 'clamp(1.5rem, 5vw, 2rem)', margin: '0 0 20px 0', letterSpacing: '0.1em', fontFamily: '"Outfit", monospace', color: '#fff', textShadow: '0 0 10px #00ff41' };
const inputStyle: React.CSSProperties = { padding: '15px', backgroundColor: 'transparent', border: '1px solid #00ff41', color: '#00ff41', fontFamily: '"Outfit", monospace', fontSize: '1.2rem', width: '100%', maxWidth: '300px', outline: 'none', boxSizing: 'border-box' };
const buttonStyle: React.CSSProperties = { padding: '15px', border: '2px solid #00ff41', backgroundColor: 'transparent', color: '#00ff41', fontFamily: '"Outfit", monospace', cursor: 'pointer', fontSize: '1rem', letterSpacing: '0.2em', transition: 'all 0.2s', width: '100%', maxWidth: '300px', boxSizing: 'border-box' };
const actionButtonStyle = (active: boolean): React.CSSProperties => ({ padding: '15px', backgroundColor: '#000', color: active ? '#00ff41' : '#444', border: `2px solid ${active ? '#00ff41' : '#444'}`, fontFamily: '"Outfit", monospace', cursor: active ? 'pointer' : 'not-allowed', fontSize: '1rem', letterSpacing: '2px', boxShadow: active ? '0 0 20px rgba(0,255,65,0.35)' : 'none', opacity: active ? 1 : 0.6, width: '100%', maxWidth: '300px', boxSizing: 'border-box', transition: 'all 0.2s' });

const resultOverlayStyle: React.CSSProperties = { position: 'absolute', top: '40px', left: '50%', transform: 'translateX(-50%)', zIndex: 4500, padding: '20px 30px', backgroundColor: 'rgba(0,0,0,0.95)', border: '2px solid #00ff41', borderRadius: '8px', color: '#fff', width: '90%', maxWidth: '500px', maxHeight: '45vh', overflowY: 'auto', boxShadow: '0 0 40px rgba(0,255,65,0.4)', fontFamily: '"Outfit", monospace', boxSizing: 'border-box' };