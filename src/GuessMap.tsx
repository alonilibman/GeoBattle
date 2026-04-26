import { useEffect, useRef, useState } from 'react';
import { importLibrary } from '@googlemaps/js-api-loader';

interface GuessMapProps {
  onGuessSelected: (latLng: { lat: number, lng: number }) => void;
  actualLocation: { lat: number, lng: number } | null;
  roundKey: number; // מפתח שמתעדכן כדי לאפס את המפה
}

export default function GuessMap({ onGuessSelected, actualLocation, roundKey }: GuessMapProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const guessMarkerRef = useRef<any>(null);
  const actualMarkerRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);
  
  const [mapSize, setMapSize] = useState<'S' | 'M' | 'L'>('S');
  const isPlayingRef = useRef(true); // שומר סטטוס כדי למנוע קליקים אחרי סיום

  // 1. אתחול המפה (רץ פעם אחת)
  useEffect(() => {
    const initMap = async () => {
      const { Map } = await importLibrary('maps') as any;

      if (mapDivRef.current && !mapInstance.current) {
        mapInstance.current = new Map(mapDivRef.current, {
          center: { lat: 20, lng: 0 },
          zoom: 1,
          disableDefaultUI: true,
          zoomControl: true,
          mapId: 'DEMO_MAP_ID', 
          gestureHandling: 'greedy'
        });

        // האזנה לקליק - מניח סיכה של השחקן
        mapInstance.current.addListener('click', async (e: any) => {
          if (!isPlayingRef.current) return; // חוסם לחיצות אם הראונד נגמר

          const { Marker } = await importLibrary('marker') as any;
          const latLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          
          if (guessMarkerRef.current) {
            guessMarkerRef.current.setPosition(latLng);
          } else {
            guessMarkerRef.current = new Marker({
              position: latLng,
              map: mapInstance.current,
            });
          }
          onGuessSelected(latLng);
        });
      }
    };
    initMap();
  }, [onGuessSelected]);

  // 2. מנגנון הריסט (מוחק הכל כשמתחיל ראונד חדש)
  useEffect(() => {
    if (guessMarkerRef.current) guessMarkerRef.current.setMap(null);
    if (actualMarkerRef.current) actualMarkerRef.current.setMap(null);
    if (polylineRef.current) polylineRef.current.setMap(null);
    
    guessMarkerRef.current = null;
    actualMarkerRef.current = null;
    polylineRef.current = null;
    isPlayingRef.current = true;
    
    setMapSize('S'); // מקטין חזרה את המפה

    if (mapInstance.current) {
      mapInstance.current.setCenter({ lat: 20, lng: 0 });
      mapInstance.current.setZoom(1);
    }
  }, [roundKey]);

  // 3. מנגנון התוצאה (מצייר קו וסיכה אמיתית)
  useEffect(() => {
    const drawResult = async () => {
      if (actualLocation && guessMarkerRef.current && mapInstance.current) {
        isPlayingRef.current = false; // נועל את המפה
      
        const { Marker } = await importLibrary('marker') as any;
        const googleNamespace = (window as any).google;
      
        // סיכה ירוקה למיקום האמיתי
        actualMarkerRef.current = new Marker({
          position: actualLocation,
          map: mapInstance.current,
          icon: { url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png' },
          animation: googleNamespace.maps.Animation.DROP
        });

        const guessPos = guessMarkerRef.current.getPosition();

        // קו אדום בין הניחוש למציאות
        polylineRef.current = new googleNamespace.maps.Polyline({
          path: [guessPos, actualLocation],
          geodesic: true,
          strokeColor: '#ff4141',
          strokeOpacity: 1.0,
          strokeWeight: 2,
          map: mapInstance.current
        });

        // מתרחק כדי להראות את שתי הנקודות
        const bounds = new googleNamespace.maps.LatLngBounds();
        bounds.extend(guessPos);
        bounds.extend(actualLocation);
        mapInstance.current.fitBounds(bounds);
      
        // מגדיל את המפה אוטומטית כדי שההשחקן יראה את התוצאה טוב
        setMapSize('M');
      }
    };
    drawResult();
  }, [actualLocation]);

  // מנגנון שינוי הגודל
  const toggleSize = () => {
    setMapSize(prev => prev === 'S' ? 'M' : prev === 'M' ? 'L' : 'S');
  };

  const getDynamicDimensions = () => {
    switch (mapSize) {
      case 'L': return { width: '85vw', height: '75vh' };
      case 'M': return { width: '600px', height: '400px' };
      case 'S': default:  return { width: '320px', height: '220px' };
    }
  };

  return (
    <div style={{ ...baseContainerStyle, ...getDynamicDimensions() }}>
      <button onClick={toggleSize} style={resizeButtonStyle}>
        {mapSize === 'S' && '[+] EXPAND'}
        {mapSize === 'M' && '[++] MAXIMIZE'}
        {mapSize === 'L' && '[-] MINIMIZE'}
      </button>
      <div ref={mapDivRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

// --- Styles ---
const baseContainerStyle: React.CSSProperties = {
  position: 'absolute', bottom: '100px', left: '20px', zIndex: 3000,
  border: '2px solid #00ff41', borderRadius: '4px', overflow: 'hidden',
  boxShadow: '0 0 20px rgba(0,0,0,0.8)', backgroundColor: '#000',
  transition: 'width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
};

const resizeButtonStyle: React.CSSProperties = {
  position: 'absolute', top: '10px', right: '10px', zIndex: 3100,
  backgroundColor: 'rgba(0, 0, 0, 0.8)', color: '#00ff41', border: '1px solid #00ff41',
  padding: '5px 10px', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer',
  boxShadow: '0 0 10px rgba(0,255,65,0.2)'
};