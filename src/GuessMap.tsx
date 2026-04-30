import { useEffect, useRef, useState } from 'react';
import { importLibrary } from '@googlemaps/js-api-loader';

interface GuessMapProps {
  onGuessSelected: (latLng: { lat: number, lng: number }) => void;
  actualLocation: { lat: number, lng: number } | null;
  roundKey: number;
}

export default function GuessMap({ onGuessSelected, actualLocation, roundKey }: GuessMapProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const guessMarkerRef = useRef<any>(null);
  const actualMarkerRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null); // שומר את האנימציה כדי שנוכל לעצור אותה
  
  const [mapSize, setMapSize] = useState<'S' | 'M' | 'L'>('S');
  const isPlayingRef = useRef(true);
  const resultShownRef = useRef(false);

  // 1. אתחול ראשוני
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

        mapInstance.current.addListener('click', async (e: any) => {
          if (!isPlayingRef.current) return;
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

  // 2. איפוס מוחלט בכל ראונד
  useEffect(() => {
    if (guessMarkerRef.current) guessMarkerRef.current.setMap(null);
    if (actualMarkerRef.current) actualMarkerRef.current.setMap(null);
    if (polylineRef.current) polylineRef.current.setMap(null);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    
    guessMarkerRef.current = null;
    actualMarkerRef.current = null;
    polylineRef.current = null;
    isPlayingRef.current = true;
    resultShownRef.current = false;
    
    setMapSize('S');

    if (mapInstance.current) {
      mapInstance.current.setCenter({ lat: 20, lng: 0 });
      mapInstance.current.setZoom(1);
    }
  }, [roundKey]);

  // 3. תצוגת תוצאות сиנמטית (Zoom + אנימציית חץ)
  useEffect(() => {
    const showResultSequence = async () => {
      if (actualLocation && guessMarkerRef.current && mapInstance.current && !resultShownRef.current) {
        resultShownRef.current = true;
        isPlayingRef.current = false;
        
        const googleNamespace = (window as any).google;
        const guessPos = guessMarkerRef.current.getPosition();
        
        // מגדיל את המפה דרך CSS
        setMapSize('L'); 

        // ממתין שההגדלה תסתיים, ואז מתחיל את האקשן של גוגל מפות
        setTimeout(() => {
          if (!mapInstance.current) return;

          // מבצע Zoom-in/Out חכם שרואה את שתי הנקודות
          const bounds = new googleNamespace.maps.LatLngBounds();
          bounds.extend(guessPos);
          bounds.extend(actualLocation);
          mapInstance.current.fitBounds(bounds, { padding: 80 });

          // זורק את הסיכה האמיתית
          actualMarkerRef.current = new googleNamespace.maps.Marker({
            position: actualLocation,
            map: mapInstance.current,
            icon: { url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png' },
            animation: googleNamespace.maps.Animation.DROP
          });

          // מצייר קו עם חץ מונפש
          const lineSymbol = {
            path: googleNamespace.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 4,
            strokeColor: '#00ff41'
          };

          polylineRef.current = new googleNamespace.maps.Polyline({
            path: [guessPos, actualLocation],
            geodesic: true,
            strokeColor: '#ff4141',
            strokeOpacity: 0.5,
            strokeWeight: 2,
            icons: [{ icon: lineSymbol, offset: '0%' }],
            map: mapInstance.current
          });

          // פונקציית אנימציה שרצה בלופ ומזיזה את החץ על הקו
          let count = 0;
          const animateArrow = () => {
            count = (count + 1) % 200;
            const icons = polylineRef.current.get('icons');
            if (icons && icons[0]) {
              icons[0].offset = (count / 2) + '%';
              polylineRef.current.set('icons', icons);
            }
            animFrameRef.current = requestAnimationFrame(animateArrow);
          };
          animateArrow();

        }, 450); // ממתין חצי שנייה להתייצבות הגודל
      }
    };
    showResultSequence();
  }, [actualLocation]);

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
  boxShadow: '0 0 30px rgba(0,0,0,0.8)', backgroundColor: '#000',
  transition: 'width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
};

const resizeButtonStyle: React.CSSProperties = {
  position: 'absolute', top: '10px', right: '10px', zIndex: 3100,
  backgroundColor: 'rgba(0, 0, 0, 0.8)', color: '#00ff41', border: '1px solid #00ff41',
  padding: '5px 10px', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer',
};