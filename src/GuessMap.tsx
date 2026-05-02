import { useEffect, useRef, useState } from 'react';
import { importLibrary } from '@googlemaps/js-api-loader';

interface GuessMapProps {
  onGuessSelected: (latLng: { lat: number, lng: number }) => void;
  actualLocation: { lat: number, lng: number } | null;
  allGuesses?: any[];
  roundKey: number;
  isLockedIn?: boolean;
}

export default function GuessMap({ onGuessSelected, actualLocation, allGuesses, roundKey, isLockedIn }: GuessMapProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const localGuessMarkerRef = useRef<any>(null);
  const playerMarkersRef = useRef<any[]>([]);
  const polylinesRef = useRef<any[]>([]);
  const actualMarkerRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null);
  
  const [mapSize, setMapSize] = useState<'S' | 'M' | 'L'>('S');
  const isPlayingRef = useRef(true);
  const resultShownRef = useRef(false);

  // THE FIX: This Ref ensures the map listener ALWAYS knows the true lock status
  const isLockedInRef = useRef(isLockedIn);
  useEffect(() => {
    isLockedInRef.current = isLockedIn;
  }, [isLockedIn]);

  // 1. Init
  useEffect(() => {
    const initMap = async () => {
      const { Map } = await importLibrary('maps') as any;
      if (mapDivRef.current && !mapInstance.current) {
        mapInstance.current = new Map(mapDivRef.current, {
          center: { lat: 20, lng: 0 }, zoom: 1, disableDefaultUI: true, zoomControl: true, mapId: 'DEMO_MAP_ID', gestureHandling: 'greedy'
        });

        mapInstance.current.addListener('click', async (e: any) => {
          // Now safely checks the dynamic Ref instead of a frozen state
          if (!isPlayingRef.current || isLockedInRef.current) return; 
          
          const { Marker } = await importLibrary('marker') as any;
          const latLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          
          if (localGuessMarkerRef.current) localGuessMarkerRef.current.setPosition(latLng);
          else localGuessMarkerRef.current = new Marker({ position: latLng, map: mapInstance.current });
          onGuessSelected(latLng);
        });
      }
    };
    initMap();
  }, [onGuessSelected]); // Removed isLockedIn dependency to prevent duplicate listener attempts

  // 2. Reset
  useEffect(() => {
    if (localGuessMarkerRef.current) localGuessMarkerRef.current.setMap(null);
    if (actualMarkerRef.current) actualMarkerRef.current.setMap(null);
    playerMarkersRef.current.forEach(m => m.setMap(null));
    polylinesRef.current.forEach(p => p.setMap(null));
    playerMarkersRef.current = []; polylinesRef.current = [];
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    
    localGuessMarkerRef.current = null; actualMarkerRef.current = null;
    isPlayingRef.current = true; resultShownRef.current = false;
    setMapSize('S');

    if (mapInstance.current) {
      mapInstance.current.setCenter({ lat: 20, lng: 0 });
      mapInstance.current.setZoom(1);
    }
  }, [roundKey]);

  // 3. Cinematic Results
  useEffect(() => {
    const showResultSequence = async () => {
      if (actualLocation && mapInstance.current && !resultShownRef.current) {
        resultShownRef.current = true; isPlayingRef.current = false;
        const googleNamespace = (window as any).google;
        
        if (localGuessMarkerRef.current) localGuessMarkerRef.current.setMap(null);
        setMapSize('M'); 

        setTimeout(() => {
          if (!mapInstance.current) return;
          const bounds = new googleNamespace.maps.LatLngBounds();
          bounds.extend(actualLocation);

          let playersToPlot = (allGuesses && allGuesses.length > 0) ? allGuesses : [];

          playersToPlot.forEach((player) => {
              if (!player.currentGuess) return; 
              bounds.extend(player.currentGuess);

              playerMarkersRef.current.push(new googleNamespace.maps.Marker({
                  position: player.currentGuess, map: mapInstance.current,
                  icon: {
                      url: `https://api.dicebear.com/8.x/bottts/svg?seed=${player.avatarSeed}`,
                      scaledSize: new googleNamespace.maps.Size(40, 40),
                      anchor: new googleNamespace.maps.Point(20, 20)
                  },
                  title: player.name,
              }));

              polylinesRef.current.push(new googleNamespace.maps.Polyline({
                path: [player.currentGuess, actualLocation], geodesic: true, strokeColor: '#ff4141', strokeOpacity: 0.5, strokeWeight: 2,
                icons: [{ icon: { path: googleNamespace.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 4, strokeColor: '#00ff41' }, offset: '0%' }],
                map: mapInstance.current
              }));
          });

          actualMarkerRef.current = new googleNamespace.maps.Marker({
            position: actualLocation, map: mapInstance.current,
            icon: { url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png' }, animation: googleNamespace.maps.Animation.DROP
          });

          mapInstance.current.fitBounds(bounds, { padding: 40 });

          let count = 0;
          const animateArrows = () => {
            count = (count + 1) % 200;
            polylinesRef.current.forEach(line => {
                const icons = line.get('icons');
                if (icons && icons[0]) { icons[0].offset = (count / 2) + '%'; line.set('icons', icons); }
            });
            animFrameRef.current = requestAnimationFrame(animateArrows);
          };
          animateArrows();

        }, 450); 
      }
    };
    showResultSequence();
  }, [actualLocation, allGuesses]);

  const toggleSize = () => setMapSize(prev => prev === 'S' ? 'M' : prev === 'M' ? 'L' : 'S');

  const getDynamicDimensions = () => {
    switch (mapSize) {
      case 'L': return { width: '90vw', height: '70vh', bottom: '15vh', left: '5vw' };
      case 'M': return { width: '90vw', maxWidth: '800px', height: '45vh', bottom: '20px', left: '50%', transform: 'translateX(-50%)' };
      case 'S': default: return { width: '150px', height: '150px', bottom: '90px', left: '20px' };
    }
  };

  return (
    <div style={{ ...baseContainerStyle, ...getDynamicDimensions() }}>
      <button onClick={toggleSize} style={resizeButtonStyle}>
        {mapSize === 'S' && '[+]'}
        {mapSize === 'M' && '[++]'}
        {mapSize === 'L' && '[-]'}
      </button>
      <div ref={mapDivRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

const baseContainerStyle: React.CSSProperties = {
  position: 'absolute', zIndex: 3000, border: '2px solid #00ff41', borderRadius: '4px', overflow: 'hidden',
  boxShadow: '0 0 30px rgba(0,0,0,0.8)', backgroundColor: '#000', transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
};

const resizeButtonStyle: React.CSSProperties = {
  position: 'absolute', top: '10px', right: '10px', zIndex: 3100, backgroundColor: 'rgba(0, 0, 0, 0.8)', color: '#00ff41', border: '1px solid #00ff41',
  padding: '5px 10px', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer',
};