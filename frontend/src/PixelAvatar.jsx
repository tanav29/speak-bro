import { useEffect, useState } from "react";

/**
 * A retro 24x24 pixel-art avatar component that dynamically reacts to the voice state and volume.
 *
 * Phases:
 * - "idle": Calm blinking companion
 * - "listening": Attentive, ears and antenna glow green
 * - "thinking": Processing, scanning eye animation, purple glow
 * - "speaking": Talking mouth synced to voiceLevel, happy eyes, pink/magenta highlights
 * - "error": Sad expression, X-eyes, red warning light
 */
export function PixelAvatar({
  phase = "idle",
  voiceLevel = 0,
  className = "",
}) {
  const [blink, setBlink] = useState(false);
  const [thinkFrame, setThinkFrame] = useState(0);

  // Blinking logic for idle phase
  useEffect(() => {
    if (phase !== "idle") return;
    const interval = setInterval(
      () => {
        setBlink(true);
        setTimeout(() => setBlink(false), 200);
      },
      4000 + Math.random() * 3000,
    );
    return () => clearInterval(interval);
  }, [phase]);

  // Thinking animation frame ticker
  useEffect(() => {
    if (phase !== "thinking") return;
    const interval = setInterval(() => {
      setThinkFrame((f) => (f + 1) % 4);
    }, 200);
    return () => clearInterval(interval);
  }, [phase]);

  // Choose colors based on the current phase
  let eyeColor = "#38bdf8"; // cyan/sky for idle
  let screenBg = "#090d16"; // dark OLED slate
  let casingColor = "#475569"; // slate-600
  let casingDetail = "#64748b"; // slate-500
  let antennaColor = "#38bdf8";
  let mouthColor = "#38bdf8";
  let earColor = "#334155"; // slate-700
  let cheekColor = "transparent";

  if (phase === "listening") {
    eyeColor = "#34d399"; // green
    antennaColor = "#34d399";
    mouthColor = "#34d399";
    cheekColor = "rgba(52, 211, 153, 0.4)";
  } else if (phase === "thinking") {
    eyeColor = "#c084fc"; // purple
    antennaColor = "#c084fc";
    mouthColor = "#c084fc";
  } else if (phase === "speaking") {
    eyeColor = "#f472b6"; // pink
    antennaColor = "#f472b6";
    mouthColor = "#f472b6";
    cheekColor = "rgba(244, 114, 182, 0.3)";
  } else if (phase === "error") {
    eyeColor = "#fb7185"; // rose/red
    antennaColor = "#fb7185";
    mouthColor = "#fb7185";
  }

  // Generate eyes path/elements based on state
  const renderEyes = () => {
    if (phase === "error") {
      // X eyes
      return (
        <>
          {/* Left X */}
          <rect x="7" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="9" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="8" y="11" width="1" height="1" fill={eyeColor} />
          <rect x="7" y="12" width="1" height="1" fill={eyeColor} />
          <rect x="9" y="12" width="1" height="1" fill={eyeColor} />

          {/* Right X */}
          <rect x="14" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="16" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="15" y="11" width="1" height="1" fill={eyeColor} />
          <rect x="14" y="12" width="1" height="1" fill={eyeColor} />
          <rect x="16" y="12" width="1" height="1" fill={eyeColor} />
        </>
      );
    }

    if (phase === "thinking") {
      // Spinning/scanning eyes
      // Frame 0: Left eye up, Right eye down
      // Frame 1: Left eye right, Right eye left
      // Frame 2: Left eye down, Right eye up
      // Frame 3: Left eye left, Right eye right
      const offsets = [
        [
          [8, 10],
          [15, 12],
        ],
        [
          [9, 11],
          [14, 11],
        ],
        [
          [8, 12],
          [15, 10],
        ],
        [
          [7, 11],
          [16, 11],
        ],
      ];
      const [[lx, ly], [rx, ry]] = offsets[thinkFrame];
      return (
        <>
          <rect x={lx} y={ly} width="2" height="2" fill={eyeColor} />
          <rect x={rx} y={ry} width="2" height="2" fill={eyeColor} />
        </>
      );
    }

    if (phase === "speaking") {
      // Happy arch eyes: ^ ^
      return (
        <>
          {/* Left arch */}
          <rect x="7" y="11" width="1" height="1" fill={eyeColor} />
          <rect x="8" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="9" y="11" width="1" height="1" fill={eyeColor} />

          {/* Right arch */}
          <rect x="14" y="11" width="1" height="1" fill={eyeColor} />
          <rect x="15" y="10" width="1" height="1" fill={eyeColor} />
          <rect x="16" y="11" width="1" height="1" fill={eyeColor} />
        </>
      );
    }

    if (phase === "listening") {
      // Wide open curious eyes
      return (
        <>
          <rect x="7" y="9" width="2" height="3" fill={eyeColor} />
          <rect x="15" y="9" width="2" height="3" fill={eyeColor} />
        </>
      );
    }

    // Default "idle" phase (with blink action)
    if (blink) {
      return (
        <>
          {/* Flat shut eyes */}
          <rect x="7" y="11" width="2" height="1" fill={eyeColor} />
          <rect x="15" y="11" width="2" height="1" fill={eyeColor} />
        </>
      );
    }

    // Default regular eyes
    return (
      <>
        <rect x="7" y="10" width="2" height="2" fill={eyeColor} />
        <rect x="15" y="10" width="2" height="2" fill={eyeColor} />
      </>
    );
  };

  // Generate mouth path/elements based on state
  const renderMouth = () => {
    if (phase === "error") {
      // Sad squiggly mouth
      return (
        <>
          <rect x="10" y="15" width="4" height="1" fill={mouthColor} />
          <rect x="9" y="16" width="1" height="1" fill={mouthColor} />
          <rect x="14" y="16" width="1" height="1" fill={mouthColor} />
        </>
      );
    }

    if (phase === "listening") {
      // Open O-mouth
      return <rect x="11" y="14" width="2" height="2" fill={mouthColor} />;
    }

    if (phase === "speaking") {
      // Dynamically height-scaling speaking mouth using voiceLevel (0-100)
      const maxMouthHeight = 4;
      const computedHeight = Math.max(
        1,
        Math.min(maxMouthHeight, Math.floor(voiceLevel / 20)),
      );
      const startY = 16 - Math.floor(computedHeight / 2);
      return (
        <rect
          x="10"
          y={startY}
          width="4"
          height={computedHeight}
          fill={mouthColor}
          rx="0.5"
        />
      );
    }

    // Default / Thinking / Idle flat mouth
    return <rect x="10" y="15" width="4" height="1" fill={mouthColor} />;
  };

  // Pulse animation for the antenna light
  const getAntennaBulbOpacity = () => {
    if (phase === "listening") return "animate-pulse";
    if (phase === "thinking") return "animate-ping";
    return "";
  };

  return (
    <div
      className={`relative flex items-center justify-center select-none ${className}`}>
      {/* SVG canvas */}
      <svg
        viewBox="0 0 24 24"
        className="w-full h-full drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]"
        style={{ imageRendering: "pixelated" }}>
        {/* Antenna Pole */}
        <rect x="11" y="2" width="2" height="4" fill="#334155" />

        {/* Antenna Light Bulb */}
        <rect
          x="10"
          y="0"
          width="4"
          height="2"
          fill={antennaColor}
          className={getAntennaBulbOpacity()}
          style={{ transformOrigin: "12px 1px" }}
        />

        {/* Ears */}
        <rect x="2" y="10" width="2" height="6" fill={earColor} />
        <rect x="20" y="10" width="2" height="6" fill={earColor} />

        {/* Robot Head Outer Frame */}
        {/* Row 6 */}
        <rect x="6" y="5" width="12" height="1" fill={casingColor} />
        {/* Row 7 */}
        <rect x="5" y="6" width="14" height="1" fill={casingColor} />
        {/* Middle part (y=7 to y=19) */}
        <rect x="4" y="7" width="16" height="13" fill={casingColor} />
        {/* Row 21 */}
        <rect x="5" y="20" width="14" height="1" fill={casingColor} />
        {/* Row 22 */}
        <rect x="6" y="21" width="12" height="1" fill={casingColor} />

        {/* Casing Highlights (Inner casing border) */}
        <rect x="6" y="6" width="12" height="1" fill={casingDetail} />
        <rect x="5" y="7" width="1" height="13" fill={casingDetail} />
        <rect x="18" y="7" width="1" height="13" fill={casingDetail} />
        <rect x="6" y="19" width="12" height="1" fill={casingDetail} />

        {/* OLED Screen Screen (Dark area inside casing) */}
        <rect x="6" y="8" width="12" height="10" fill={screenBg} rx="0.5" />

        {/* Cheek Blush */}
        {cheekColor !== "transparent" && (
          <>
            <rect x="6" y="13" width="1" height="1" fill={cheekColor} />
            <rect x="17" y="13" width="1" height="1" fill={cheekColor} />
          </>
        )}

        {/* Eyes */}
        {renderEyes()}

        {/* Mouth */}
        {renderMouth()}
      </svg>
    </div>
  );
}
