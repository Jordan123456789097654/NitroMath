import React, { useState, useEffect } from "react";
import { Activity, Wifi, ShieldCheck, Zap, RefreshCw } from "lucide-react";

export default function NetworkPingTester({ C }: { C: any }) {
  const [wsPing, setWsPing] = useState<number | null>(null);
  const [proxyPing, setProxyPing] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [history, setHistory] = useState<{ time: string; ws: number; proxy: number }[]>([]);

  const runTest = async () => {
    setTesting(true);
    const startWs = performance.now();
    try {
      await fetch("/api/health", { cache: "no-store" });
      const wsMs = Math.round(performance.now() - startWs);
      setWsPing(wsMs);

      const startProxy = performance.now();
      await fetch("/api/gateway?url=" + encodeURIComponent("https://httpbin.org/get"), { method: "HEAD", cache: "no-store" }).catch(() => {});
      const proxyMs = Math.round(performance.now() - startProxy);
      setProxyPing(proxyMs);

      setHistory((prev) => [
        { time: new Date().toLocaleTimeString(), ws: wsMs, proxy: proxyMs },
        ...prev.slice(0, 4),
      ]);
    } catch (e) {
      setWsPing(999);
      setProxyPing(999);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    runTest();
    const interval = setInterval(runTest, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "14px",
        background: C?.surface || "rgba(255,255,255,0.03)",
        border: `1px solid ${C?.border || "rgba(255,255,255,0.08)"}`,
        marginTop: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Activity size={16} style={{ color: C?.accent || "#00f0ff" }} />
          <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 650, color: C?.text || "#fff" }}>
            Network Ping & Proxy Speed Monitor
          </h4>
        </div>
        <button
          onClick={runTest}
          disabled={testing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 10px",
            borderRadius: "6px",
            background: "transparent",
            border: `1px solid ${C?.borderFocus || "rgba(255,255,255,0.2)"}`,
            color: C?.textSub || "#aaa",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={12} className={testing ? "animate-spin" : ""} />
          {testing ? "Testing..." : "Test Now"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
        <div
          style={{
            padding: "12px",
            borderRadius: "10px",
            background: "rgba(0,0,0,0.2)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: C?.textMuted || "#888" }}>
            <Wifi size={13} /> WebSocket Latency
          </div>
          <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "4px", color: wsPing && wsPing < 100 ? "#4ade80" : wsPing && wsPing < 250 ? "#facc15" : "#f87171" }}>
            {wsPing !== null ? `${wsPing} ms` : "--"}
          </div>
        </div>

        <div
          style={{
            padding: "12px",
            borderRadius: "10px",
            background: "rgba(0,0,0,0.2)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: C?.textMuted || "#888" }}>
            <Zap size={13} /> Stealth Proxy Response
          </div>
          <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "4px", color: proxyPing && proxyPing < 200 ? "#4ade80" : proxyPing && proxyPing < 500 ? "#facc15" : "#f87171" }}>
            {proxyPing !== null ? `${proxyPing} ms` : "--"}
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div style={{ fontSize: "11px", color: C?.textSub || "#aaa" }}>
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>Recent Ping Logs</div>
          {history.map((h, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <span>{h.time}</span>
              <span>WS: {h.ws}ms | Proxy: {h.proxy}ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
