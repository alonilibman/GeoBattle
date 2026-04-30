import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase'; 
import GuessMap from './GuessMap';
import './StreetView.css'; 

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
if (API_KEY) {
  setOptions({ key: API_KEY, v: 'weekly' });
}

type GameState = 'START' | 'MP_MENU' | 'CREATE_LOBBY' | 'JOIN_LOBBY' | 'LOBBY' | 'PLAYING' | 'ROUND_OVER' | 'GAME_OVER';

interface Player {
  id: string;
  name: string;
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
  
  const [gameState, setGameState] = useState<GameState>('START');
  const [isWarping, setIsWarping] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ status: 'SYSTEM OFFLINE' });
  
  const [currentGuess, setCurrentGuess] = useState<{lat: number, lng: number} | null>(null);
  const [actualLocation, setActualLocation] = useState<{lat: number, lng: number} | null>(null);
  const [roundKey, setRoundKey] = useState(0);

  // Multiplayer & Lobby States
  const [playerName, setPlayerName] = useState('');
  const [playerId] = useState(() => Math.random().toString(36).substring(2, 9));
  const [lobbyCode, setLobbyCode] = useState('')
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [lobbyData, setLobbyData] = useState<any>(null);
  
  // Settings for Host Creation
  const [settings, setSettings] = useState({
    roundTime: 60,
    timeAfterFirstGuess: 15,
    maxRounds: 5,
    pointsToWin: 0,
    elimination: false
  });

  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  // Initialize Maps (Fixing Phone Motion Tracking)
  useEffect(() => {
    let isMounted = true;
    const init = async () => {
      try {
        const { StreetViewPanorama, StreetViewService } = await importLibrary('streetView') as any;
        if (!isMounted) return;
        googleServiceRef.current = new StreetViewService();
        if (mapRef.current && !panoInstance.current) {
          panoInstance.current = new StreetViewPanorama(mapRef.current, {
            position: { lat: 48.8738, lng: 2.2950 },
            zoom: 1,
            visible: true,
            source: 'outdoor' as any,
            addressControl: false,
            showRoadLabels: false,
            motionTracking: false,        // FIX 1: Disable phone tilt movement
            motionTrackingControl: false  // FIX 1: Remove the compass tilt button
          });
        }
      } catch (err) { console.error(err); }
    };
    setTimeout(init, 500);
    return () => { isMounted = false; };
  }, []);

  // --- MULTIPLAYER REAL-TIME SYNC ---
  useEffect(() => {
    if (!lobbyCode) return;
    
    const unsub = onSnapshot(doc(db, 'lobbies', lobbyCode), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        
        // Host has started the game/round
        if (data.status === 'PLAYING' && data.targetLocation && gameState !== 'PLAYING') {
           if (!isHost) executeWarp(data.targetLocation);
           setCurrentGuess(null);
        }

        // Host has ended the round
        if (data.status === 'ROUND_OVER' && gameState !== 'ROUND_OVER') {
          setGameState('ROUND_OVER');
          setActualLocation(data.targetLocation);
        }

        // Host has ended the game
        if (data.status === 'GAME_OVER' && gameState !== 'GAME_OVER') {
          setGameState('GAME_OVER');
        }
      }
    });

    return () => unsub();
  }, [lobbyCode, isHost, gameState]);

  // --- TIMER LOGIC ---
  useEffect(() => {
    if (gameState === 'PLAYING' && lobbyData?.roundEndTime) {
      const interval = setInterval(() => {
        const remaining = Math.max(0, Math.floor((lobbyData.roundEndTime - Date.now()) / 1000));
        setTimeLeft(remaining);

        // Host handles Auto-Ending the round when time is up
        if (remaining <= 0 && isHost) {
          endRound(lobbyData);
        }
      }, 500);
      return () => clearInterval(interval);
    } else {
      setTimeLeft(null);
    }
  }, [gameState, lobbyData, isHost]);

  const executeWarp = (pos: {lat: number, lng: number}) => {
    setIsWarping(true);
    setGameState('PLAYING');
    setRoundKey(prev => prev + 1);
    
    panoInstance.current.setPosition(pos);
    panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
    setDiagnostics({ status: 'TARGET LOCKED.' });
    
    setTimeout(() => setIsWarping(false), 800);
  };

  const handleChaosWarp = async () => {
    if (!googleServiceRef.current || !panoInstance.current) return;
    
    setIsWarping(true);
    setGameState('PLAYING');
    setCurrentGuess(null);
    setRoundKey(prev => prev + 1);
    setDiagnostics({ status: 'SEARCHING SIGNAL...' });

    let found = false;
    let attempts = 0;
    while (!found && attempts < 50) {
      attempts++;
      const lat = (Math.random() * 140) - 70;
      const lng = (Math.random() * 360) - 180;
      
      try {
        const response = await googleServiceRef.current.getPanorama({
          location: { lat, lng },
          radius: 50000,
          source: 'outdoor' as any
        });
        
        if (response?.data) {
          const copyright = response.data.copyright || '';
          const links = response.data.links || [];
          
          if (!copyright.includes('Google') || links.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }

          const pos = { lat: response.data.location.latLng.lat(), lng: response.data.location.latLng.lng() };
          
          panoInstance.current.setPosition(pos);
          setActualLocation(pos);
          panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
          
          if (lobbyCode && isHost && lobbyData) {
            // Reset players' guesses for the new round
            const resetPlayers = lobbyData.players.map((p: Player) => ({ ...p, currentGuess: null, distance: null, pointsEarned: null }));
            
            await updateDoc(doc(db, 'lobbies', lobbyCode), {
              status: 'PLAYING',
              targetLocation: pos,
              roundEndTime: Date.now() + (lobbyData.settings.roundTime * 1000),
              currentRound: (lobbyData.currentRound || 0) + 1,
              players: resetPlayers
            });
          }

          found = true;
          setDiagnostics({ status: 'TARGET LOCKED.' });
          setTimeout(() => setIsWarping(false), 800);
        }
      } catch (e) { 
        await new Promise(resolve => setTimeout(resolve, 250)); 
      }
    }
    if (!found) setDiagnostics({ status: 'WARP FAILED. TRY AGAIN.' });
  };

  const calculateDistance = (p1: {lat: number, lng: number}, p2: {lat: number, lng: number}) => {
    const R = 6371; 
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const submitGuess = async () => {
    if (!currentGuess || !lobbyData || gameState !== 'PLAYING') return;

    const updatedPlayers = lobbyData.players.map((p: Player) => 
      p.id === playerId ? { ...p, currentGuess } : p
    );

    let newEndTime = lobbyData.roundEndTime;
    const guessesCount = updatedPlayers.filter((p: Player) => p.currentGuess).length;

    // Fast-Forward timer if someone guesses and it's the first guess
    if (guessesCount === 1) {
      const potentialNewEnd = Date.now() + (lobbyData.settings.timeAfterFirstGuess * 1000);
      if (potentialNewEnd < newEndTime) {
        newEndTime = potentialNewEnd;
      }
    }

    await updateDoc(doc(db, 'lobbies', lobbyCode), {
      players: updatedPlayers,
      roundEndTime: newEndTime
    });

    // If everyone guessed, host ends round immediately
    if (isHost && guessesCount === lobbyData.players.length) {
      endRound({ ...lobbyData, players: updatedPlayers });
    }
  };

  const endRound = async (currentLobbyData: any) => {
    if (!isHost) return;

    // Calculate scores for everyone
    const scoredPlayers = currentLobbyData.players.map((p: Player) => {
      let points = 0;
      let dist = null;
      if (p.currentGuess && currentLobbyData.targetLocation) {
        dist = calculateDistance(p.currentGuess, currentLobbyData.targetLocation);
        points = Math.max(0, Math.round(5000 * Math.exp(-dist / 2000)));
      }
      return { ...p, distance: dist, pointsEarned: points, score: (p.score || 0) + points };
    });

    // Check Win/Game Over conditions
    const isMaxRoundsHit = currentLobbyData.currentRound >= currentLobbyData.settings.maxRounds;
    const hasPointWinner = currentLobbyData.settings.pointsToWin > 0 && scoredPlayers.some((p:Player) => p.score >= currentLobbyData.settings.pointsToWin);
    
    // Sort by score
    scoredPlayers.sort((a:Player, b:Player) => b.score - a.score);

    // Apply Elimination logic
    let finalPlayers = scoredPlayers;
    if (currentLobbyData.settings.elimination && scoredPlayers.length > 1) {
       // Optional: Remove lowest score player logic can go here. For now just marking.
       finalPlayers[finalPlayers.length - 1].name += " (AT RISK)";
    }

    await updateDoc(doc(db, 'lobbies', lobbyCode), {
      status: (isMaxRoundsHit || hasPointWinner) ? 'GAME_OVER' : 'ROUND_OVER',
      players: finalPlayers
    });
  };

  // --- LOBBY CREATION & JOINING ---
  const handleCreateLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim()) return;
    
    const newCode = Math.floor(10000 + Math.random() * 90000).toString();
    const newPlayer: Player = { id: playerId, name: playerName, isHost: true, score: 0, currentGuess: null, distance: null, pointsEarned: null };
    
    await setDoc(doc(db, 'lobbies', newCode), {
      status: 'LOBBY',
      targetLocation: null,
      settings: settings,
      currentRound: 0,
      players: [newPlayer]
    });

    setLobbyCode(newCode);
    setIsHost(true);
    setGameState('LOBBY');
  };

  const handleJoinLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim() || joinCodeInput.length !== 5) return;

    const lobbyRef = doc(db, 'lobbies', joinCodeInput);
    const lobbySnap = await getDoc(lobbyRef);

    if (lobbySnap.exists()) {
      const data = lobbySnap.data();
      if (data.players.length >= 8) return alert("Lobby is full!");
      if (data.status !== 'LOBBY') return alert("Game already in progress!");
      
      const newPlayer: Player = { id: playerId, name: playerName, isHost: false, score: 0, currentGuess: null, distance: null, pointsEarned: null };
      
      await updateDoc(lobbyRef, { players: [...data.players, newPlayer] });
      setLobbyCode(joinCodeInput);
      setIsHost(false);
      setGameState('LOBBY');
    } else {
      alert("Lobby not found. Check the code.");
    }
  };

  // --- RENDERERS ---
  const renderCreateLobby = () => (
    <form onSubmit={handleCreateLobby} className="menu-container">
      <h2 className="subtitle">INITIALIZE LOBBY</h2>
      <input autoFocus placeholder="ENTER CALLSIGN" value={playerName} onChange={(e) => setPlayerName(e.target.value)} className="terminal-input" maxLength={15} style={{marginBottom: '20px'}}/>
      
      <div className="settings-grid">
        <label className="settings-label">ROUND TIME (SEC)
          <input type="number" value={settings.roundTime} onChange={e => setSettings({...settings, roundTime: Number(e.target.value)})} className="terminal-input" min="10" max="300" />
        </label>
        <label className="settings-label">TIME AFTER 1ST GUESS (SEC)
          <input type="number" value={settings.timeAfterFirstGuess} onChange={e => setSettings({...settings, timeAfterFirstGuess: Number(e.target.value)})} className="terminal-input" min="5" max="60" />
        </label>
        <label className="settings-label">MAX ROUNDS
          <input type="number" value={settings.maxRounds} onChange={e => setSettings({...settings, maxRounds: Number(e.target.value)})} className="terminal-input" min="1" max="10" />
        </label>
        <label className="settings-label">POINTS TO WIN (0 = Disable)
          <input type="number" value={settings.pointsToWin} onChange={e => setSettings({...settings, pointsToWin: Number(e.target.value)})} className="terminal-input" min="0" />
        </label>
        <label className="settings-label">ELIMINATION MODE
          <select value={settings.elimination ? 'YES' : 'NO'} onChange={e => setSettings({...settings, elimination: e.target.value === 'YES'})} className="terminal-select">
            <option value="NO">NO</option>
            <option value="YES">YES</option>
          </select>
        </label>
      </div>

      <button type="submit" disabled={!playerName} className="action-btn">GENERATE CODE</button>
      <button type="button" onClick={() => setGameState('MP_MENU')} className="base-btn" style={{border: 'none', marginTop: '10px'}}>BACK</button>
    </form>
  );

  return (
    <div className="app-container">
      <div ref={mapRef} className="map-layer" style={{ opacity: (['START', 'MP_MENU', 'CREATE_LOBBY', 'JOIN_LOBBY', 'LOBBY', 'ROUND_OVER', 'GAME_OVER'].includes(gameState) || isWarping) ? 0 : 1 }} />

      <div className="warp-screen" style={{ opacity: isWarping ? 1 : 0, pointerEvents: isWarping ? 'all' : 'none' }}>
        <div className="warp-text">WARPING...</div>
        <div className="diagnostics-text">{diagnostics.status}</div>
      </div>

      {/* HUD (Timer & Players) */}
      {gameState === 'PLAYING' && (
        <div className="hud-container">
           {timeLeft !== null && (
             <div className={`timer ${timeLeft <= 15 ? 'warning' : ''}`}>
               00:{timeLeft.toString().padStart(2, '0')}
             </div>
           )}
           <div className="player-status-list">
             {lobbyData?.players.map((p: Player) => (
               <div key={p.id} style={{ color: p.currentGuess ? '#00ff41' : '#fff' }}>
                 {p.currentGuess ? '✅ ' : '⏳ '}{p.name}
               </div>
             ))}
           </div>
        </div>
      )}

      {(gameState === 'PLAYING' || gameState === 'ROUND_OVER' || gameState === 'GAME_OVER') && (
        <>
          {/* NOTICE: We pass ALL guesses to GuessMap so it can draw them in post-round! */}
          <GuessMap 
            onGuessSelected={setCurrentGuess} 
            actualLocation={gameState === 'ROUND_OVER' || gameState === 'GAME_OVER' ? actualLocation : null} 
            allGuesses={gameState === 'ROUND_OVER' || gameState === 'GAME_OVER' ? lobbyData?.players : []}
            roundKey={roundKey} 
          />
        </>
      )}

      {(gameState === 'PLAYING') && (
        <div className="controls-container">
          <button onClick={submitGuess} disabled={!currentGuess || lobbyData?.players.find((p:Player)=>p.id===playerId)?.currentGuess} className="action-btn">
             {lobbyData?.players.find((p:Player)=>p.id===playerId)?.currentGuess ? 'LOCKED IN' : 'LOCK GUESS'}
          </button>
        </div>
      )}

      {/* LEADERBOARD / ROUND SUMMARY */}
      {(gameState === 'ROUND_OVER' || gameState === 'GAME_OVER') && lobbyData && (
        <div className="result-overlay">
          <h2 style={{ color: gameState === 'GAME_OVER' ? '#ffd700' : '#00ff41' }}>
            {gameState === 'GAME_OVER' ? 'GAME COMPLETE' : `ROUND ${lobbyData.currentRound} COMPLETE`}
          </h2>
          
          <div style={{ textAlign: 'left', marginTop: '20px' }}>
            {lobbyData.players.map((p: Player, i: number) => (
              <div key={p.id} className="player-score-row">
                <span style={{ fontWeight: 'bold' }}>{i + 1}. {p.name}</span>
                <span style={{ color: '#aaa' }}>
                  +{p.pointsEarned || 0} pts 
                  ({p.distance !== null ? (p.distance < 1 ? `${(p.distance * 1000).toFixed(0)}m` : `${p.distance.toFixed(1)}km`) : 'No Guess'})
                </span>
                <span style={{ color: '#00ff41', fontWeight: 'bold', marginLeft: '10px' }}>TOTAL: {p.score}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '30px' }}>
            {isHost ? (
               gameState === 'GAME_OVER' ? (
                 <button onClick={() => setGameState('START')} className="action-btn">RETURN TO MENU</button>
               ) : (
                 <button onClick={handleChaosWarp} className="action-btn">INITIATE NEXT WARP</button>
               )
            ) : (
               <div style={{ color: '#888' }}>WAITING FOR HOST...</div>
            )}
          </div>
        </div>
      )}

      {/* ... (START, MP_MENU, JOIN_LOBBY, LOBBY renderers stay exactly the same as before, just referencing the new classes) ... */}
      
      {gameState === 'START' && (
        <div className="landing-container">
          <h1 className="title">GEOBATTLE</h1>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button onClick={handleChaosWarp} className="base-btn">SINGLE PLAYER</button>
            <button onClick={() => setGameState('MP_MENU')} className="base-btn">MULTI PLAYER</button>
          </div>
        </div>
      )}
      
      {gameState === 'CREATE_LOBBY' && renderCreateLobby()}
    </div>
  );
}