import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState } from './types';
import { LIDO_HANDBOOK_TEXT } from './constants';
import { createBlob, decode, decodeAudioData } from './utils/audioUtils';

// Icon Components
const MicIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
  </svg>
);

const StopIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" />
  </svg>
);

const WaveformIcon = ({ active }: { active: boolean }) => (
  <div className={`flex items-end gap-1 h-8 ${active ? 'opacity-100' : 'opacity-30'}`}>
    <div className={`w-1.5 bg-lido-gold rounded-full transition-all duration-150 ease-in-out ${active ? 'animate-[bounce_0.8s_infinite]' : 'h-2'}`}></div>
    <div className={`w-1.5 bg-lido-gold rounded-full transition-all duration-150 ease-in-out delay-75 ${active ? 'animate-[bounce_0.6s_infinite]' : 'h-4'}`}></div>
    <div className={`w-1.5 bg-lido-gold rounded-full transition-all duration-150 ease-in-out delay-150 ${active ? 'animate-[bounce_1s_infinite]' : 'h-3'}`}></div>
    <div className={`w-1.5 bg-lido-gold rounded-full transition-all duration-150 ease-in-out delay-100 ${active ? 'animate-[bounce_0.7s_infinite]' : 'h-5'}`}></div>
    <div className={`w-1.5 bg-lido-gold rounded-full transition-all duration-150 ease-in-out ${active ? 'animate-[bounce_0.9s_infinite]' : 'h-2'}`}></div>
  </div>
);

const App: React.FC = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  
  // Close Session Function
  const closeSession = useCallback(() => {
    if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then(session => session.close()).catch(() => {});
        sessionPromiseRef.current = null;
    }
    
    // Stop Microphone Stream
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
    }

    // Disconnect Input Audio Logic
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (inputAudioContextRef.current) {
        inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
    }

    // Stop Output Audio
    if (outputAudioContextRef.current) {
        outputAudioContextRef.current.close();
        outputAudioContextRef.current = null;
    }
    
    // Clear audio sources
    sourcesRef.current.forEach(source => {
        try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    setConnectionState(ConnectionState.DISCONNECTED);
    setIsSpeaking(false);
  }, []);

  // Connect Function
  const connectToGemini = useCallback(async () => {
    setConnectionState(ConnectionState.CONNECTING);
    setErrorMsg(null);

    try {
        const apiKey = process.env.API_KEY;
        if (!apiKey) {
            throw new Error("API_KEY environment variable is missing.");
        }

        // Initialize Audio Contexts
        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const inputNode = inputAudioContextRef.current!.createGain();
        const outputNode = outputAudioContextRef.current!.createGain();
        outputNode.connect(outputAudioContextRef.current!.destination);

        // Get Microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const ai = new GoogleGenAI({ apiKey });
        
        const config = {
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            callbacks: {
                onopen: () => {
                    console.log('Session opened');
                    setConnectionState(ConnectionState.CONNECTED);
                    
                    // Setup Audio Input Streaming
                    if (!inputAudioContextRef.current) return;
                    
                    const source = inputAudioContextRef.current.createMediaStreamSource(stream);
                    const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                    scriptProcessorRef.current = scriptProcessor;

                    scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                        const pcmBlob = createBlob(inputData);
                        
                        if (sessionPromiseRef.current) {
                            sessionPromiseRef.current.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        }
                    };

                    source.connect(scriptProcessor);
                    scriptProcessor.connect(inputAudioContextRef.current.destination);
                },
                onmessage: async (message: LiveServerMessage) => {
                    if (!outputAudioContextRef.current) return;

                    // Handle Audio Output
                    const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                    if (base64EncodedAudioString) {
                        setIsSpeaking(true);
                        // Reset speaking indicator after a timeout if no new audio comes
                        // In a real app we might track playback time more precisely
                        setTimeout(() => setIsSpeaking(false), 2000); 

                        nextStartTimeRef.current = Math.max(
                            nextStartTimeRef.current,
                            outputAudioContextRef.current.currentTime
                        );
                        
                        const audioBuffer = await decodeAudioData(
                            decode(base64EncodedAudioString),
                            outputAudioContextRef.current,
                            24000,
                            1
                        );
                        
                        const source = outputAudioContextRef.current.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(outputNode);
                        source.addEventListener('ended', () => {
                            sourcesRef.current.delete(source);
                            if (sourcesRef.current.size === 0) setIsSpeaking(false);
                        });
                        
                        source.start(nextStartTimeRef.current);
                        nextStartTimeRef.current += audioBuffer.duration;
                        sourcesRef.current.add(source);
                    }

                    // Handle Interruption
                    const interrupted = message.serverContent?.interrupted;
                    if (interrupted) {
                        console.log('Interrupted');
                        sourcesRef.current.forEach(source => source.stop());
                        sourcesRef.current.clear();
                        nextStartTimeRef.current = 0;
                        setIsSpeaking(false);
                    }
                },
                onerror: (e: ErrorEvent) => {
                    console.error('Session error', e);
                    setErrorMsg("Connection error occurred.");
                    closeSession();
                },
                onclose: (e: CloseEvent) => {
                    console.log('Session closed', e);
                    setConnectionState(ConnectionState.DISCONNECTED);
                    setIsSpeaking(false);
                }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                },
                systemInstruction: `You are the expert voice assistant for Lido Bar. You have access to the full Operative Handbook. Your goal is to help staff by answering questions about recipes, procedures, values, and policies accurately. Always be concise, friendly, and professional, reflecting the "Lido" vibe (Venetian elegance). Use the following text as your knowledge base: ${LIDO_HANDBOOK_TEXT}`,
            },
        };

        // Start Connection
        sessionPromiseRef.current = ai.live.connect(config);

    } catch (err) {
        console.error("Failed to connect:", err);
        setErrorMsg("Failed to access microphone or connect to AI.");
        setConnectionState(ConnectionState.ERROR);
    }
  }, [closeSession]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
        closeSession();
    };
  }, [closeSession]);

  const toggleConnection = () => {
    if (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING) {
        closeSession();
    } else {
        connectToGemini();
    }
  };

  return (
    <div className="min-h-screen bg-lido-cream text-lido-dark font-sans selection:bg-lido-gold selection:text-white flex flex-col">
      {/* Header */}
      <header className="px-6 py-6 flex justify-between items-center border-b border-lido-green/10">
        <div>
          <h1 className="font-serif text-3xl text-lido-green font-bold tracking-tight">Lido</h1>
          <p className="text-xs uppercase tracking-widest text-lido-gold font-medium mt-1">Operative Handbook Assistant</p>
        </div>
        <div className="flex items-center gap-3">
             <div className={`h-2.5 w-2.5 rounded-full ${
                connectionState === ConnectionState.CONNECTED ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 
                connectionState === ConnectionState.CONNECTING ? 'bg-amber-400 animate-pulse' :
                'bg-red-400'
             }`}></div>
             <span className="text-xs font-medium opacity-60">
                {connectionState === ConnectionState.CONNECTED ? 'LIVE' : 
                 connectionState === ConnectionState.CONNECTING ? 'CONNECTING...' : 'OFFLINE'}
             </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        
        {/* Background Decorative Elements */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-lido-green/5 rounded-full blur-3xl pointer-events-none"></div>

        <div className="max-w-md w-full z-10 text-center space-y-12">
            
            {/* Visualizer / Status Area */}
            <div className="h-48 flex items-center justify-center">
                {connectionState === ConnectionState.CONNECTED ? (
                    <div className="space-y-6">
                        <div className="flex justify-center items-center gap-2">
                             <WaveformIcon active={isSpeaking} />
                        </div>
                        <p className="text-lido-green/70 font-serif italic text-lg animate-pulse">
                            {isSpeaking ? "Lido is speaking..." : "Listening..."}
                        </p>
                    </div>
                ) : (
                    <div className="text-center space-y-4">
                         <div className="w-20 h-20 mx-auto bg-lido-green/10 rounded-full flex items-center justify-center text-lido-green/40">
                            <MicIcon className="w-8 h-8" />
                         </div>
                         <p className="text-lido-dark/60">Connect to start the voice assistant.</p>
                    </div>
                )}
            </div>

            {/* Error Message */}
            {errorMsg && (
                <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm border border-red-100">
                    {errorMsg}
                </div>
            )}

            {/* Controls */}
            <div className="flex flex-col items-center gap-6">
                <button
                    onClick={toggleConnection}
                    className={`
                        relative group overflow-hidden px-8 py-4 rounded-full transition-all duration-300 shadow-xl
                        ${connectionState === ConnectionState.CONNECTED 
                            ? 'bg-white border-2 border-red-500 text-red-500 hover:bg-red-50' 
                            : 'bg-lido-green text-white hover:bg-lido-green/90 hover:scale-105'
                        }
                    `}
                >
                    <div className="flex items-center gap-3 font-semibold text-lg">
                        {connectionState === ConnectionState.CONNECTED ? (
                            <>
                                <StopIcon className="w-6 h-6" />
                                <span>End Session</span>
                            </>
                        ) : (
                            <>
                                <MicIcon className="w-6 h-6" />
                                <span>Start Conversation</span>
                            </>
                        )}
                    </div>
                </button>
                
                {connectionState === ConnectionState.DISCONNECTED && (
                    <p className="text-sm text-lido-dark/40 max-w-xs mx-auto">
                        Ask about recipes, opening hours, service standards, or anything in the handbook.
                    </p>
                )}
            </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="py-6 text-center text-lido-dark/30 text-xs">
        <p>© Lido Bar Vienna • Staff Internal Use Only</p>
      </footer>
    </div>
  );
};

export default App;