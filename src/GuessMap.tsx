import { useEffect, useRef, useState } from 'react';
import { importLibrary } from '@googlemaps/js-api-loader';

interface GuessMapProps {
  onGuessSelected: (latLng: { lat: number, lng: number }) => void;
  actualLocation: { lat: number, lng: number } | null;
  allGuesses?: any[]; // <--- NEW: Receives all multiplayer guesses
  roundKey: number;
}

export default function GuessMap({ onGuessSelected, actualLocation, allGuesses, roundKey }: GuessMapProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  
  // Local active guess (during gameplay)
  const localGuessMarkerRef = useRef<any>(null); 
  
  // End-of-round arrays (for multiplayer rendering)
  const playerMarkersRef = useRef<any[]>([]);
  const polylinesRef = useRef<any[]>([]);
  const actualMarkerRef = useRef<any>(null);
  
  const animFrameRef = useRef<number | null>(null);
  const [mapSize, setMapSize] = useState<'S' | 'M' | 'L'>('S');
  const isPlayingRef = useRef(true);
  const resultShownRef = useRef(false);

  // 1. Initial Setup
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
          
          if (localGuessMarkerRef.current) {
            localGuessMarkerRef.current.setPosition(latLng);
          } else {
            localGuessMarkerRef.current = new Marker({
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

  // 2. Total Reset per round
  useEffect(() => {
    if (localGuessMarkerRef.current) localGuessMarkerRef.current.setMap(null);
    if (actualMarkerRef.current) actualMarkerRef.current.setMap(null);
    
    // Clear all multiplayer markers and lines
    playerMarkersRef.current.forEach(m => m.setMap(null));
    polylinesRef.current.forEach(p => p.setMap(null));
    playerMarkersRef.current = [];
    polylinesRef.current = [];
    
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    
    localGuessMarkerRef.current = null;
    actualMarkerRef.current = null;
    isPlayingRef.current = true;
    resultShownRef.current = false;
    
    setMapSize('S');

    if (mapInstance.current) {
      mapInstance.current.setCenter({ lat: 20, lng: 0 });
      mapInstance.current.setZoom(1);
    }
  }, [roundKey]);

  // 3. Cinematic Results (Multiplayer Support)
  useEffect(() => {
    const showResultSequence = async () => {
      if (actualLocation && mapInstance.current && !resultShownRef.current) {
        resultShownRef.current = true;
        isPlayingRef.current = false;
        
        const googleNamespace = (window as any).google;
        
        // Hide the local active guess marker so we can draw the official labeled ones
        if (localGuessMarkerRef.current) {
            localGuessMarkerRef.current.setMap(null);
        }
        
        setMapSize('L'); 

        setTimeout(() => {
          if (!mapInstance.current) return;

          const bounds = new googleNamespace.maps.LatLngBounds();
          bounds.extend(actualLocation);

          // Determine if we are plotting a single player or an entire lobby
          let playersToPlot = [];
          if (allGuesses && allGuesses.length > 0) {
              playersToPlot = allGuesses;
          } else if (localGuessMarkerRef.current) {
              // Fallback for single player if allGuesses isn't passed
              playersToPlot = [{ name: 'YOU', currentGuess: localGuessMarkerRef.current.getPosition() }];
          }

          const lineSymbol = {
            path: googleNamespace.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 4,
            strokeColor: '#00ff41'
          };

          // Loop through every player and draw their marker and line
          playersToPlot.forEach((player) => {
              if (!player.currentGuess) return; // Skip players who didn't guess in time
              
              const pos = player.currentGuess;
              bounds.extend(pos);

              // Create Player Marker
              const pMarker = new googleNamespace.maps.Marker({
                  position: pos,
                  map: mapInstance.current,
                  label: {
                      text: player.name.substring(0, 2).toUpperCase(),
                      color: "#000",
                      fontWeight: "bold"
                  },
                  title: player.name,
              });
              playerMarkersRef.current.push(pMarker);

              // Create Line to Destination
              const pLine = new googleNamespace.maps.Polyline({
                path: [pos, actualLocation],
                geodesic: true,
                strokeColor: '#ff4141',
                strokeOpacity: 0.5,
                strokeWeight: 2,
                icons: [{ icon: lineSymbol, offset: '0%' }],
                map: mapInstance.current
              });
              polylinesRef.current.push(pLine);
          });

          // Drop the Actual Location Marker
          actualMarkerRef.current = new googleNamespace.maps.Marker({
            position: actualLocation,
            map: mapInstance.current,
            icon: { url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png' },
            animation: googleNamespace.maps.Animation.DROP
          });

          // Smart Zoom to fit everyone
          mapInstance.current.fitBounds(bounds, { padding: 80 });

          // Animate ALL arrows simultaneously
          let count = 0;
          const animateArrows = () => {
            count = (count + 1) % 200;
            polylinesRef.current.forEach(line => {
                const icons = line.get('icons');
                if (icons && icons[0]) {
                  icons[0].offset = (count / 2) + '%';
                  line.set('icons', icons);
                }
            });
            animFrameRef.current = requestAnimationFrame(animateArrows);
          };
          animateArrows();

        }, 450); 
      }
    };
    showResultSequence();
  }, [actualLocation, allGuesses]);

  const toggleSize = () => {
    setMapSize(prev => prev === 'S' ? 'M' : prev === 'M' ? 'L' : 'S');
  };

  const getDynamicDimensions = () => {
    switch (mapSize) {
      case 'L': return { width: '85vw', height: '75vh', bottom: '10vh', left: '7.5vw' };
      case 'M': return { width: '600px', height: '400px', bottom: '100px', left: '20px' };
      case 'S': default:  return { width: '320px', height: '220px', bottom: '100px', left: '20px' };
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
  position: 'absolute', zIndex: 3000,
  border: '2px solid #00ff41', borderRadius: '4px', overflow: 'hidden',
  boxShadow: '0 0 30px rgba(0,0,0,0.8)', backgroundColor: '#000',
  transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
};

const resizeButtonStyle: React.CSSProperties = {
  position: 'absolute', top: '10px', right: '10px', zIndex: 3100,
  backgroundColor: 'rgba(0, 0, 0, 0.8)', color: '#00ff41', border: '1px solid #00ff41',
  padding: '5px 10px', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer',
};