import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase'; // <-- Import your Firestore setup
import GuessMap from './GuessMap';

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
  const [playerId] = useState(() => Math.random().toString(36).substring(2, 9)); // Generate random local ID
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
    
    // This listens to the specific lobby document in Firestore
    const unsub = onSnapshot(doc(db, 'lobbies', lobbyCode), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setPlayers(data.players || []);
        
        // If the host changed the state to playing and provided coordinates, warp the clients!
        if (data.status === 'PLAYING' && data.targetLocation && !isHost && gameState === 'LOBBY') {
           executeWarp(data.targetLocation);
        }
      }
    });

    return () => unsub(); // Cleanup listener on unmount
  }, [lobbyCode, isHost, gameState]);

  // Execute warp to a specific coordinate (used by non-hosts to follow the host)
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

  // Host finding a random location
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
          radius: 100000,
          source: 'outdoor' as any
        });
        
        if (response?.data) {
          const copyright = response.data.copyright || '';
          const links = response.data.links || [];
          
          if (!copyright.includes('Google') || links.length === 0) continue;

          const pos = { lat: response.data.location.latLng.lat(), lng: response.data.location.latLng.lng() };
          
          // Warp the host locally
          panoInstance.current.setPosition(pos);
          setActualLocation(pos);
          panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
          
          // If in a lobby, tell Firestore to warp everyone else!
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
      } catch (e) { /* Retry */ }
    }
    if (!found) setDiagnostics({ status: 'WARP FAILED. TRY AGAIN.' });
  };

  // --- LOBBY ACTIONS ---

  const handleCreateLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim()) return;
    
    const newCode = Math.floor(10000 + Math.random() * 90000).toString();
    const newPlayer = { id: playerId, name: playerName, isHost: true };
    
    // Create new lobby in Firestore
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
      
      // Update Firestore with new player
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

  // ... (Distance and submit guess logic remains the same)
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
    <div style={menuContainerStyle}>
      <h2 style={subtitleStyle}>MULTIPLAYER UPLINK</h2>
      <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
        <button onClick={() => setGameState('CREATE_LOBBY')} style={buttonStyle}>CREATE LOBBY</button>
        <button onClick={() => setGameState('JOIN_LOBBY')} style={buttonStyle}>JOIN LOBBY</button>
      </div>
      <button onClick={() => setGameState('START')} style={{ ...buttonStyle, marginTop: '30px', borderColor: '#444', color: '#888' }}>ABORT</button>
    </div>
  );

  const renderCreateLobby = () => (
    <form onSubmit={handleCreateLobby} style={menuContainerStyle}>
      <h2 style={subtitleStyle}>INITIALIZE LOBBY</h2>
      <input 
        autoFocus placeholder="ENTER CALLSIGN (NICKNAME)" value={playerName} 
        onChange={(e) => setPlayerName(e.target.value)} style={inputStyle} maxLength={15}
      />
      <button type="submit" disabled={!playerName} style={actionButtonStyle(!!playerName)}>GENERATE CODE</button>
      <button type="button" onClick={() => setGameState('MP_MENU')} style={{ ...buttonStyle, marginTop: '20px', border: 'none' }}>BACK</button>
    </form>
  );

  const renderJoinLobby = () => (
    <form onSubmit={handleJoinLobby} style={menuContainerStyle}>
      <h2 style={subtitleStyle}>JOIN UPLINK</h2>
      <input 
        autoFocus placeholder="ENTER 5-DIGIT CODE" value={joinCodeInput} 
        onChange={(e) => setJoinCodeInput(e.target.value.replace(/\D/g, '').slice(0, 5))} 
        style={{ ...inputStyle, textAlign: 'center', letterSpacing: '10px', fontSize: '2rem' }} 
      />
      <input 
        placeholder="ENTER CALLSIGN (NICKNAME)" value={playerName} 
        onChange={(e) => setPlayerName(e.target.value)} style={inputStyle} maxLength={15}
      />
      <button type="submit" disabled={!playerName || joinCodeInput.length !== 5} style={actionButtonStyle(!!playerName && joinCodeInput.length === 5)}>CONNECT</button>
      <button type="button" onClick={() => setGameState('MP_MENU')} style={{ ...buttonStyle, marginTop: '20px', border: 'none' }}>BACK</button>
    </form>
  );

  const renderLobbyRoom = () => (
    <div style={menuContainerStyle}>
      <h2 style={subtitleStyle}>LOBBY: {lobbyCode}</h2>
      <div style={{ color: '#00ff41', opacity: 0.7, marginBottom: '20px' }}>PLAYERS ({players.length}/8)</div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', width: '100%', maxWidth: '600px', marginBottom: '30px' }}>
        {players.map((p) => (
          <div key={p.id} style={{ padding: '15px', border: '1px solid #00ff41', backgroundColor: 'rgba(0,255,65,0.1)', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}>
            <span>{p.name}</span>
            {p.isHost && <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>[HOST]</span>}
          </div>
        ))}
        {Array.from({ length: 8 - players.length }).map((_, i) => (
           <div key={`empty-${i}`} style={{ padding: '15px', border: '1px dashed #444', color: '#444', textAlign: 'left' }}>[ EMPTY SLOT ]</div>
        ))}
      </div>

      {isHost ? (
        <button onClick={handleChaosWarp} style={actionButtonStyle(true)}>INITIATE WARP (START)</button>
      ) : (
        <div style={{ padding: '15px', color: '#888', border: '1px solid #444' }}>WAITING FOR HOST TO INITIATE...</div>
      )}
      
      <button onClick={() => { setGameState('START'); setLobbyCode(''); }} style={{ ...buttonStyle, marginTop: '30px', borderColor: '#444', color: '#888' }}>LEAVE LOBBY</button>
    </div>
  );

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      
      <div 
        ref={mapRef} 
        style={{ 
          width: '100%', height: '100%', position: 'absolute',
          opacity: (['START', 'MP_MENU', 'CREATE_LOBBY', 'JOIN_LOBBY', 'LOBBY'].includes(gameState) || isWarping) ? 0 : 1,
          transition: 'opacity 0.6s ease'
        }} 
      />

      <div style={{ 
        position: 'absolute', inset: 0, zIndex: 4000, backgroundColor: '#000', 
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', 
        transition: 'opacity 0.4s', opacity: isWarping ? 1 : 0, pointerEvents: isWarping ? 'all' : 'none' 
      }}>
        <div style={{ color: '#00ff41', fontFamily: 'monospace', fontSize: '2rem', letterSpacing: '8px' }}>WARPING...</div>
        <div style={{ color: '#00ff41', opacity: 0.6, marginTop: '20px', fontFamily: 'monospace' }}>{diagnostics.status}</div>
      </div>

      {(gameState === 'PLAYING' || gameState === 'RESULT') && (
        <>
          <GuessMap onGuessSelected={setCurrentGuess} actualLocation={gameState === 'RESULT' ? actualLocation : null} roundKey={roundKey} />
          <div style={{ position: 'absolute', bottom: '30px', left: '20px', zIndex: 3500, display: 'flex', gap: '10px' }}>
             {gameState === 'PLAYING' ? (
               <button onClick={submitGuess} disabled={!currentGuess} style={actionButtonStyle(!!currentGuess)}>LOCK GUESS [SPACE]</button>
             ) : (
               isHost || !lobbyCode ? (
                 <button onClick={handleChaosWarp} style={actionButtonStyle(true)}>NEXT ROUND</button>
               ) : (
                 <div style={{...actionButtonStyle(false), backgroundColor: 'rgba(0,0,0,0.8)'}}>WAITING FOR HOST</div>
               )
             )}
          </div>
        </>
      )}

      {gameState === 'RESULT' && distance !== null && points !== null && (
        <div style={resultOverlayStyle}>
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
        <div style={landingStyle}>
          <h1 style={titleStyle}>GEOBATTLE</h1>
          <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
            <button onClick={handleChaosWarp} style={buttonStyle}>SINGLE PLAYER</button>
            <button onClick={() => setGameState('MP_MENU')} style={buttonStyle}>MULTI PLAYER</button>
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

// --- Styles ---
const landingStyle: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 4500, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 1)', color: '#00ff41', textAlign: 'center', gap: '20px' };
const menuContainerStyle: React.CSSProperties = { ...landingStyle, gap: '15px', backgroundColor: 'rgba(0,0,0,0.95)' };
const titleStyle: React.CSSProperties = { fontSize: '4rem', margin: 0, letterSpacing: '0.25em' };
const subtitleStyle: React.CSSProperties = { fontSize: '2rem', margin: '0 0 20px 0', letterSpacing: '0.1em', fontFamily: 'monospace', color: '#fff', textShadow: '0 0 10px #00ff41' };
const inputStyle: React.CSSProperties = { padding: '15px', backgroundColor: 'transparent', border: '1px solid #00ff41', color: '#00ff41', fontFamily: 'monospace', fontSize: '1.2rem', width: '300px', outline: 'none', textAlign: 'center' };
const buttonStyle: React.CSSProperties = { padding: '15px 35px', border: '2px solid #00ff41', backgroundColor: 'transparent', color: '#00ff41', fontFamily: 'monospace', cursor: 'pointer', fontSize: '1rem', letterSpacing: '0.2em', transition: 'all 0.2s' };
const actionButtonStyle = (active: boolean): React.CSSProperties => ({ padding: '15px 30px', backgroundColor: '#000', color: active ? '#00ff41' : '#444', border: `2px solid ${active ? '#00ff41' : '#444'}`, fontFamily: 'monospace', cursor: active ? 'pointer' : 'not-allowed', fontSize: '1rem', letterSpacing: '2px', boxShadow: active ? '0 0 20px rgba(0,255,65,0.35)' : 'none', opacity: active ? 1 : 0.6, transition: 'all 0.2s ease-in-out', marginTop: '10px' });
const resultOverlayStyle: React.CSSProperties = { position: 'absolute', top: '20%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 4500, padding: '30px 50px', backgroundColor: 'rgba(0,0,0,0.9)', border: '2px solid #00ff41', borderRadius: '8px', color: '#fff', textAlign: 'center', minWidth: '300px', boxShadow: '0 0 40px rgba(0,255,65,0.4)', fontFamily: 'monospace' };