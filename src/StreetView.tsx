import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import GuessMap from './GuessMap';

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
if (API_KEY) {
  setOptions({ key: API_KEY, v: 'weekly' });
}

export default function StreetView() {
  const mapRef = useRef<HTMLDivElement>(null);
  const panoInstance = useRef<any>(null);
  const googleServiceRef = useRef<any>(null);
  
  const [gameState, setGameState] = useState<'START' | 'PLAYING' | 'RESULT'>('START');
  const [isWarping, setIsWarping] = useState(false);
  const [currentGuess, setCurrentGuess] = useState<{lat: number, lng: number} | null>(null);
  const [actualLocation, setActualLocation] = useState<{lat: number, lng: number} | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [roundKey, setRoundKey] = useState(0);

  const [diagnostics, setDiagnostics] = useState({
    status: 'SYSTEM OFFLINE'
  });

  // אתחול בשקט (מוסתר עד לתחילת המשחק)
  useEffect(() => {
    let isMounted = true;
    const init = async () => {
      try {
        const { StreetViewPanorama, StreetViewService } = await importLibrary('streetView') as any;
        if (!isMounted) return;
        googleServiceRef.current = new StreetViewService();
        if (mapRef.current && !panoInstance.current) {
          panoInstance.current = new StreetViewPanorama(mapRef.current, {
            position: { lat: 48.8738, lng: 2.2950 }, // לא נראה לעין כי ה-Div מוסתר עכשיו
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

  // סריקה למיקומים איכותיים בלבד
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
          // אנטי-זבל: מוודא שזה צילום רשמי של גוגל ושיש לאן ללכת (חיצים בכביש)
          const copyright = response.data.copyright || '';
          const links = response.data.links || [];
          
          if (!copyright.includes('Google') || links.length === 0) {
            setDiagnostics({ status: 'POOR SIGNAL/UNOFFICIAL. RE-ROUTING...' });
            continue; // מדלג ללולאה הבאה
          }

          const pos = response.data.location.latLng;
          panoInstance.current.setPosition(pos);
          setActualLocation({ lat: pos.lat(), lng: pos.lng() });
          panoInstance.current.setPov({ heading: Math.random() * 360, pitch: 0 });
          
          found = true;
          setDiagnostics({ status: 'TARGET LOCKED.' });
          setTimeout(() => setIsWarping(false), 800); // השהייה קלה לטעינת טקסטורות
        }
      } catch (e) { /* ניסיון נוסף */ }
    }
    if (!found) setDiagnostics({ status: 'WARP FAILED. TRY AGAIN.' });
  };

  const calculateDistance = (p1: any, p2: any) => {
    const R = 6371; 
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // נוסחת הניקוד: מקס 5000, יורד אקספוננציאלית ככל שמתרחקים
  const submitGuess = useCallback(() => {
    if (!currentGuess || !actualLocation || gameState !== 'PLAYING') return;
    const dist = calculateDistance(currentGuess, actualLocation);
    
    // נוסחה: מ-0 עד 5000 נקודות. קנה מידה של 2000 ק"מ.
    const calculatedPoints = Math.max(0, Math.round(5000 * Math.exp(-dist / 2000)));
    
    setDistance(dist);
    setPoints(calculatedPoints);
    setGameState('RESULT');
  }, [currentGuess, actualLocation, gameState]);

  // מאזין למקש SPACE (רק כשיש ניחוש ובמצב משחק)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && currentGuess && gameState === 'PLAYING') {
        e.preventDefault(); // מונע מהדף לגלול למטה
        submitGuess();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentGuess, gameState, submitGuess]);

  const handleStartGame = () => {
    handleChaosWarp(); // מדלג ישר לוורפ הראשון, אין שער ניצחון יותר
  };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      
      {/* שכבת המפה - מוסתרת לחלוטין במסך הפתיחה ובזמן וורפ */}
      <div 
        ref={mapRef} 
        style={{ 
          width: '100%', height: '100%', position: 'absolute',
          opacity: (gameState === 'START' || isWarping) ? 0 : 1,
          transition: 'opacity 0.6s ease'
        }} 
      />

      {/* מסך טעינה/וורפ */}
      <div style={{ 
        position: 'absolute', inset: 0, zIndex: 4000, backgroundColor: '#000', 
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', 
        transition: 'opacity 0.4s', opacity: isWarping ? 1 : 0, pointerEvents: isWarping ? 'all' : 'none' 
      }}>
        <div style={{ color: '#00ff41', fontFamily: 'monospace', fontSize: '2rem', letterSpacing: '8px' }}>WARPING...</div>
        <div style={{ color: '#00ff41', opacity: 0.6, marginTop: '20px', fontFamily: 'monospace' }}>{diagnostics.status}</div>
      </div>

      {gameState !== 'START' && (
        <>
          <GuessMap 
            onGuessSelected={setCurrentGuess} 
            actualLocation={gameState === 'RESULT' ? actualLocation : null}
            roundKey={roundKey}
          />
          
          <div style={{ position: 'absolute', bottom: '30px', left: '20px', zIndex: 3500, display: 'flex', gap: '10px' }}>
             {gameState === 'PLAYING' ? (
               <button onClick={submitGuess} disabled={!currentGuess} style={actionButtonStyle(!!currentGuess)}>
                 LOCK GUESS [SPACE]
               </button>
             ) : (
               <button onClick={handleChaosWarp} style={actionButtonStyle(true)}>
                 NEXT ROUND
               </button>
             )}
          </div>
        </>
      )}

      {/* מסך התוצאה והנקודות */}
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
          <button onClick={handleStartGame} style={buttonStyle}>INITIALIZE</button>
        </div>
      )}
    </div>
  );
}

// --- Styles ---
const landingStyle: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 4500, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 1)', color: '#00ff41', textAlign: 'center', gap: '20px' };
const titleStyle: React.CSSProperties = { fontSize: '4rem', margin: 0, letterSpacing: '0.25em' };
const buttonStyle: React.CSSProperties = { padding: '15px 35px', border: '2px solid #00ff41', backgroundColor: 'transparent', color: '#00ff41', fontFamily: 'monospace', cursor: 'pointer', fontSize: '1rem', letterSpacing: '0.2em' };

const actionButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '15px 30px', backgroundColor: '#000', color: active ? '#00ff41' : '#444',
  border: `2px solid ${active ? '#00ff41' : '#444'}`, fontFamily: 'monospace', cursor: active ? 'pointer' : 'not-allowed',
  fontSize: '1rem', letterSpacing: '2px', boxShadow: active ? '0 0 20px rgba(0,255,65,0.35)' : 'none',
  opacity: active ? 1 : 0.6, transition: 'all 0.2s ease-in-out'
});

const resultOverlayStyle: React.CSSProperties = {
  position: 'absolute', top: '20%', left: '50%', transform: 'translate(-50%, -50%)',
  zIndex: 4500, padding: '30px 50px', backgroundColor: 'rgba(0,0,0,0.9)', border: '2px solid #00ff41',
  borderRadius: '8px', color: '#fff', textAlign: 'center', minWidth: '300px', boxShadow: '0 0 40px rgba(0,255,65,0.4)',
  fontFamily: 'monospace'
};