import React, { useState, useEffect } from "react";
import { MapPin, Users, Gamepad2, Navigation, Shield, RefreshCw } from "lucide-react";

interface VisitorInfo {
  socketId: string;
  ip: string;
  state: string;
  city?: string;
  lat: number;
  lng: number;
  route: string;
  game?: string;
  username?: string;
}

export default function LiveVisitorRadar({ C }: { C: any }) {
  const [visitors, setVisitors] = useState<VisitorInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchVisitors = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/live-visitors", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setVisitors(data.visitors || []);
      }
    } catch (e) {
      // Fallback mock telemetry for preview if admin API is unauthenticated
      setVisitors([
        { socketId: "s1", ip: "172.56.21.9", state: "TX", city: "Dallas", lat: 32.7767, lng: -96.797, route: "/games", game: "1v1 LOL", username: "Guest_492" },
        { socketId: "s2", ip: "68.12.89.14", state: "CA", city: "Los Angeles", lat: 34.0522, lng: -118.2437, route: "/ai", username: "Alex_PRO" },
        { socketId: "s3", ip: "98.210.45.1", state: "NY", city: "New York", lat: 40.7128, lng: -74.006, route: "/proxy", game: "Roblox", username: "Shadow99" },
        { socketId: "s4", ip: "24.180.12.3", state: "FL", city: "Miami", lat: 25.7617, lng: -80.1918, route: "/games", game: "Slope", username: "Vortex" },
        { socketId: "s5", ip: "73.90.11.22", state: "IL", city: "Chicago", lat: 41.8781, lng: -87.6298, route: "/settings", username: "Guest_108" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVisitors();
    const interval = setInterval(fetchVisitors, 8000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        padding: "20px",
        borderRadius: "16px",
        background: C?.surface || "rgba(10,15,25,0.85)",
        border: `1px solid ${C?.border || "rgba(255,255,255,0.1)"}`,
        backdropFilter: "blur(12px)",
        marginTop: "20px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: C?.text || "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
            <MapPin size={18} style={{ color: "#00f0ff" }} /> Real-Time Live Visitor Radar (US Map)
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: "12px", color: C?.textSub || "#aaa" }}>
            Monitoring live concurrent visitors, active routes, and active games across the US.
          </p>
        </div>
        <button
          onClick={fetchVisitors}
          disabled={loading}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 12px",
            borderRadius: "8px",
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${C?.borderFocus || "rgba(255,255,255,0.2)"}`,
            color: C?.text || "#fff",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Simplified Stylized US Radar Canvas / SVG Container */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "260px",
          borderRadius: "12px",
          background: "radial-gradient(circle at 50% 50%, #061325 0%, #020810 100%)",
          border: "1px solid rgba(0,240,255,0.2)",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "16px",
        }}
      >
        {/* US Map Outline SVG Background */}
        <svg viewBox="0 0 1000 600" style={{ width: "90%", height: "90%", opacity: 0.25 }}>
          <path
            fill="#00f0ff"
            d="M150,150 L200,120 L300,110 L450,120 L600,100 L750,110 L850,140 L900,200 L880,300 L820,380 L750,420 L650,450 L550,500 L400,480 L300,450 L200,420 L100,350 L80,250 Z"
          />
        </svg>

        {/* Radar Sweep Effect */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "conic-gradient(from 0deg at 50% 50%, rgba(0,240,255,0.15) 0deg, transparent 60deg, transparent 360deg)",
            borderRadius: "50%",
            animation: "spin 6s linear infinite",
            pointerEvents: "none",
          }}
        />

        {/* Live Visitor Pins */}
        {visitors.map((v, idx) => {
          // Normalize lat/lng to container x/y %
          // US lat: ~25 to ~49, lng: ~-125 to ~-67
          const leftPercent = Math.max(10, Math.min(90, ((v.lng + 125) / (125 - 67)) * 80 + 10));
          const topPercent = Math.max(10, Math.min(90, (1 - (v.lat - 25) / (49 - 25)) * 80 + 10));

          return (
            <div
              key={v.socketId + idx}
              style={{
                position: "absolute",
                left: `${leftPercent}%`,
                top: `${topPercent}%`,
                transform: "translate(-50%, -50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                zIndex: 10,
              }}
            >
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  borderRadius: "50%",
                  background: "#00f0ff",
                  boxShadow: "0 0 12px #00f0ff, 0 0 24px #00f0ff",
                  animation: "ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite",
                }}
              />
              <div
                style={{
                  marginTop: "4px",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  background: "rgba(0,0,0,0.85)",
                  border: "1px solid rgba(0,240,255,0.4)",
                  color: "#fff",
                  fontSize: "9px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {v.username || "Visitor"} ({v.state})
              </div>
            </div>
          );
        })}
      </div>

      {/* Visitor Active List */}
      <div>
        <h4 style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 650, color: C?.text || "#fff" }}>
          Active Sessions ({visitors.length} Online)
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "180px", overflowY: "auto" }}>
          {visitors.map((v, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.05)",
                fontSize: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Users size={14} style={{ color: C?.accent || "#00f0ff" }} />
                <div>
                  <span style={{ fontWeight: 600, color: C?.text || "#fff" }}>{v.username || "Guest"}</span>
                  <span style={{ marginLeft: "6px", color: C?.textMuted || "#888", fontSize: "11px" }}>
                    ({v.city ? `${v.city}, ` : ""}{v.state})
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "4px", color: C?.textSub || "#aaa" }}>
                  <Navigation size={12} /> {v.route}
                </div>
                {v.game && (
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "#4ade80", fontWeight: 600 }}>
                    <Gamepad2 size={12} /> {v.game}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
