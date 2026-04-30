import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase'; 
import GuessMap from './GuessMap';
import './StreetView.css'; // <-- Import your new CSS!

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
if (API_KEY) {
  setOptions({ key: API_KEY, v: 'weekly' });
}

type GameState = 'START' | 'MP_MENU' | 'CREATE_LOBBY' | 'JOIN_LOBBY' | 'LOBBY' | 'PLAYING' | 'RESULT';

export default function StreetView() {
  const mapRef = useRef<HTMLDivElement>(null);
  const panoInstance = useRef<any>(null);
  const googleServiceRef = useRef<any>(null);
  
  const [gameState, setGameState] = useState<GameState>('START');
  const [isWarping, setIsWarping] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ status: 'SYSTEM OFFLINE' });
  
  const [currentGuess, setCurrentGuess] = useState<{lat: number, lng: number} | null>(null);
  const [actualLocation, setActualLocation] = useState<{lat: number, lng: number} | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [roundKey, setRoundKey] = useState(0);

  // Multiplayer States
  const [playerName, setPlayerName] = useState('');
  const [playerId] = useState(() => Math.random().toString(36).substring(2, 9));
  const [lobbyCode, setLobbyCode] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [players, setPlayers] = useState<{id: string, name: string, isHost: boolean}[]>([]);

  // Silent Init Google Maps
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
          });
        }
      } catch (err) { console.error(err); }
    };
    setTimeout(init, 500);
    return () => { isMounted = false; };
  }, []);

  // --- MULTIPLAYER REAL-TIME LISTENER ---
  useEffect(() => {
    if (!lobbyCode) return;
    
    const unsub = onSnapshot(doc(db, 'lobbies', lobbyCode), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setPlayers(data.players || []);
        
        if (data.status === 'PLAYING' && data.targetLocation && !isHost && gameState === 'LOBBY') {
           executeWarp(data.targetLocation);
        }
      }
    });

    return () => unsub();
  }, [lobbyCode, isHost, gameState]);

  const executeWarp = (pos: {lat: number, lng: number}) => {
    setIsWarping(true);
    setGameState('PLAYING');
    setCurrentGuess(null);
    setDistance(null);
    setPoints(null);
    setRoundKey(prev => prev + 1);
    
    panoInstance.current.setPosition(pos);
    setActualLocation(pos);
    panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
    setDiagnostics({ status: 'TARGET LOCKED.' });
    
    setTimeout(() => setIsWarping(false), 800);
  };

  const handleChaosWarp = async () => {
    if (!googleServiceRef.current || !panoInstance.current) return;
    
    setIsWarping(true);
    setGameState('PLAYING');
    setCurrentGuess(null);
    setDistance(null);
    setPoints(null);
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
            await new Promise(resolve => setTimeout(resolve, 250)); // Re-added Speed Limit!
            continue;
          }

          const pos = { lat: response.data.location.latLng.lat(), lng: response.data.location.latLng.lng() };
          
          panoInstance.current.setPosition(pos);
          setActualLocation(pos);
          panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
          
          if (lobbyCode && isHost) {
            await updateDoc(doc(db, 'lobbies', lobbyCode), {
              status: 'PLAYING',
              targetLocation: pos
            });
          }

          found = true;
          setDiagnostics({ status: 'TARGET LOCKED.' });
          setTimeout(() => setIsWarping(false), 800);
        }
      } catch (e) { 
        await new Promise(resolve => setTimeout(resolve, 250)); // Re-added Speed Limit!
      }
    }
    if (!found) setDiagnostics({ status: 'WARP FAILED. TRY AGAIN.' });
  };

  const handleCreateLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim()) return;
    
    const newCode = Math.floor(10000 + Math.random() * 90000).toString();
    const newPlayer = { id: playerId, name: playerName, isHost: true };
    
    await setDoc(doc(db, 'lobbies', newCode), {
      status: 'LOBBY',
      targetLocation: null,
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
      const lobbyData = lobbySnap.data();
      if (lobbyData.players.length >= 8) {
        alert("Lobby is full!");
        return;
      }
      
      const newPlayer = { id: playerId, name: playerName, isHost: false };
      
      await updateDoc(lobbyRef, {
        players: [...lobbyData.players, newPlayer]
      });

      setLobbyCode(joinCodeInput);
      setIsHost(false);
      setGameState('LOBBY');
    } else {
      alert("Lobby not found. Check the code.");
    }
  };

  const calculateDistance = (p1: any, p2: any) => {
    const R = 6371; 
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const submitGuess = useCallback(() => {
    if (!currentGuess || !actualLocation || gameState !== 'PLAYING') return;
    const dist = calculateDistance(currentGuess, actualLocation);
    const calculatedPoints = Math.max(0, Math.round(5000 * Math.exp(-dist / 2000)));
    
    setDistance(dist);
    setPoints(calculatedPoints);
    setGameState('RESULT');
  }, [currentGuess, actualLocation, gameState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && currentGuess && gameState === 'PLAYING') {
        e.preventDefault();
        submitGuess();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentGuess, gameState, submitGuess]);


  // --- RENDERING ---
  const renderMultiplayerMenu = () => (
    <div className="menu-container">
      <h2 className="subtitle">MULTIPLAYER UPLINK</h2>
      <div style={{ display: 'flex', gap: '20px' }}>
        <button onClick={() => setGameState('CREATE_LOBBY')} className="base-btn">CREATE LOBBY</button>
        <button onClick={() => setGameState('JOIN_LOBBY')} className="base-btn">JOIN LOBBY</button>
      </div>
      <button onClick={() => setGameState('START')} className="base-btn secondary">ABORT</button>
    </div>
  );

  const renderCreateLobby = () => (
    <form onSubmit={handleCreateLobby} className="menu-container">
      <h2 className="subtitle">INITIALIZE LOBBY</h2>
      <input 
        autoFocus placeholder="ENTER CALLSIGN" value={playerName} 
        onChange={(e) => setPlayerName(e.target.value)} className="terminal-input" maxLength={15}
      />
      <button type="submit" disabled={!playerName} className="action-btn">GENERATE CODE</button>
      <button type="button" onClick={() => setGameState('MP_MENU')} className="base-btn" style={{border: 'none', marginTop: '10px'}}>BACK</button>
    </form>
  );

  const renderJoinLobby = () => (
    <form onSubmit={handleJoinLobby} className="menu-container">
      <h2 className="subtitle">JOIN UPLINK</h2>
      <input 
        autoFocus placeholder="ENTER CODE" value={joinCodeInput} 
        onChange={(e) => setJoinCodeInput(e.target.value.replace(/\D/g, '').slice(0, 5))} 
        className="terminal-input centered" 
      />
      <input 
        placeholder="ENTER CALLSIGN" value={playerName} 
        onChange={(e) => setPlayerName(e.target.value)} className="terminal-input" maxLength={15}
      />
      <button type="submit" disabled={!playerName || joinCodeInput.length !== 5} className="action-btn">CONNECT</button>
      <button type="button" onClick={() => setGameState('MP_MENU')} className="base-btn" style={{border: 'none', marginTop: '10px'}}>BACK</button>
    </form>
  );

  const renderLobbyRoom = () => (
    <div className="menu-container">
      <h2 className="subtitle">LOBBY: {lobbyCode}</h2>
      <div style={{ color: '#00ff41', opacity: 0.7, marginBottom: '10px' }}>PLAYERS ({players.length}/8)</div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', width: '100%', maxWidth: '600px', marginBottom: '20px' }}>
        {players.map((p) => (
          <div key={p.id} className="player-slot">
            <span>{p.name}</span>
            {p.isHost && <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>[HOST]</span>}
          </div>
        ))}
        {Array.from({ length: 8 - players.length }).map((_, i) => (
           <div key={`empty-${i}`} className="empty-slot">[ EMPTY SLOT ]</div>
        ))}
      </div>

      {isHost ? (
        <button onClick={handleChaosWarp} className="action-btn">INITIATE WARP</button>
      ) : (
        <div style={{ padding: '15px', color: '#888', border: '1px solid #444' }}>WAITING FOR HOST...</div>
      )}
      
      <button onClick={() => { setGameState('START'); setLobbyCode(''); }} className="base-btn secondary">LEAVE LOBBY</button>
    </div>
  );

  return (
    <div className="app-container">
      
      <div 
        ref={mapRef} 
        className="map-layer"
        style={{ opacity: (['START', 'MP_MENU', 'CREATE_LOBBY', 'JOIN_LOBBY', 'LOBBY'].includes(gameState) || isWarping) ? 0 : 1 }} 
      />

      <div className="warp-screen" style={{ opacity: isWarping ? 1 : 0, pointerEvents: isWarping ? 'all' : 'none' }}>
        <div className="warp-text">WARPING...</div>
        <div className="diagnostics-text">{diagnostics.status}</div>
      </div>

      {(gameState === 'PLAYING' || gameState === 'RESULT') && (
        <>
          <GuessMap onGuessSelected={setCurrentGuess} actualLocation={gameState === 'RESULT' ? actualLocation : null} roundKey={roundKey} />
          <div className="controls-container">
             {gameState === 'PLAYING' ? (
               <button onClick={submitGuess} disabled={!currentGuess} className="action-btn">LOCK GUESS [SPACE]</button>
             ) : (
               isHost || !lobbyCode ? (
                 <button onClick={handleChaosWarp} className="action-btn">NEXT ROUND</button>
               ) : (
                 <div className="action-btn disabled" style={{backgroundColor: 'rgba(0,0,0,0.8)'}}>WAITING FOR HOST</div>
               )
             )}
          </div>
        </>
      )}

      {gameState === 'RESULT' && distance !== null && points !== null && (
        <div className="result-overlay">
          <div style={{ fontSize: '1.2rem', marginBottom: '15px', borderBottom: '1px solid #00ff41', paddingBottom: '5px' }}>MISSION COMPLETE</div>
          <div style={{ fontSize: '3rem', fontWeight: 'bold', color: '#fff', textShadow: '0 0 20px #00ff41' }}>
            {points} <span style={{ fontSize: '1.5rem', opacity: 0.7 }}>PTS</span>
          </div>
          <div style={{ fontSize: '1.5rem', color: '#00ff41', marginTop: '10px' }}>
            {distance < 1 ? `${(distance * 1000).toFixed(0)} meters away` : `${distance.toFixed(1)} km away`}
          </div>
        </div>
      )}

      {gameState === 'START' && (
        <div className="landing-container">
          <h1 className="title">GEOBATTLE</h1>
          <div style={{ display: 'flex', gap: '20px' }}>
            <button onClick={handleChaosWarp} className="base-btn">SINGLE PLAYER</button>
            <button onClick={() => setGameState('MP_MENU')} className="base-btn">MULTI PLAYER</button>
          </div>
        </div>
      )}

      {gameState === 'MP_MENU' && renderMultiplayerMenu()}
      {gameState === 'CREATE_LOBBY' && renderCreateLobby()}
      {gameState === 'JOIN_LOBBY' && renderJoinLobby()}
      {gameState === 'LOBBY' && renderLobbyRoom()}
      
    </div>
  );
}